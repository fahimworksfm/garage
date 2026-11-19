import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const BAYS = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, "0"));
const BODIES = ["coupe", "sedan", "hatch", "suv", "truck"];
const FINISHES = ["gloss", "matte", "metal"];
const GLOWS = ["none", "cyan", "magenta", "lime", "amber"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

function sanitize(input) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    tag: clean(input.tag, 24),
    make: clean(input.make, 20),
    model: clean(input.model, 24),
    year: clean(input.year, 4).replace(/\D/g, ""),
    plate: clean(input.plate, 8).toUpperCase().replace(/[^A-Z0-9 -]/g, ""),
    body: pick(input.body, BODIES, "sedan"),
    paint: /^#[0-9a-fA-F]{6}$/.test(input.paint || "") ? input.paint : "#3E454D",
    finish: pick(input.finish, FINISHES, "gloss"),
    glow: pick(input.glow, GLOWS, "none"),
  };
}

const publicView = (car, key) => {
  if (!car) return null;
  const { key: owner, ...rest } = car;
  return { ...rest, mine: !!key && owner === key };
};

const digest = (v) => createHash("sha256").update(String(v)).digest();
function checkAdmin(req) {
  const secret = (globalThis.Netlify?.env?.get("ADMIN_KEY") ?? process.env.ADMIN_KEY ?? "").trim();
  const given = req.headers.get("x-admin-key") || "";
  if (!secret || !given) return false;
  return timingSafeEqual(digest(secret), digest(given));
}

export default async (req, context) => {
  const store = getStore({ name: "garage-bays", consistency: "strong" });
  const photos = getStore({ name: "garage-photos", consistency: "strong" });
  const seg = new URL(req.url).pathname.split('/').filter(Boolean);

  if (seg[0] === 'api' && seg[1] === 'photos') {
    if (req.method !== "GET" || !BAYS.includes(seg[2])) return json({ error: "Not found." }, 404);
    const data = await photos.get(seg[2], { type: "arrayBuffer" });
    if (!data) return json({ error: "No photo." }, 404);
    return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }
  const no = seg[0] === 'api' && seg[1] === 'bays' ? seg[2] : undefined;
  const key = clean(req.headers.get("x-driver-key"), 64);
  const admin = checkAdmin(req);

  if (req.method === "GET" && !no) {
    const entries = await Promise.all(BAYS.map((b) => store.get(b, { type: "json" })));
    const cars = {};
    BAYS.forEach((b, i) => { if (entries[i]) cars[b] = publicView(entries[i], key); });
    return json({ cars, admin });
  }

  if (!BAYS.includes(no)) return json({ error: "That bay does not exist." }, 404);
  if (key.length < 16 && !admin) return json({ error: "Missing driver key." }, 400);

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Send the car as JSON." }, 400); }
    const car = sanitize(body || {});
    if (!car.tag || !car.make || !car.model) return json({ error: "Add your name, make and model." }, 400);
    let photo = null;
    if (typeof body.photo === "string") {
      if (body.photo.length > 900_000 || !/^[A-Za-z0-9+/=]+$/.test(body.photo)) return json({ error: "That photo is too large." }, 413);
      photo = Buffer.from(body.photo, "base64");
      if (photo.length < 1000 || photo[0] !== 0xff || photo[1] !== 0xd8) return json({ error: "Photos must be JPEG images." }, 400);
    }
    const now = Date.now();
    const existing = await store.getWithMetadata(no, { type: "json" });
    if (existing) {
      if (existing.data?.key !== key) return json({ error: "Someone else is parked in this bay." }, 409);
      const photoV = photo ? now : body.removePhoto ? 0 : existing.data.photo || 0;
      const next = { ...car, photo: photoV, key, parkedAt: existing.data.parkedAt || now };
      const res = await store.setJSON(no, next, { onlyIfMatch: existing.etag });
      if (res && res.modified === false) return json({ error: "The bay changed. Try again." }, 409);
      if (photo) await photos.set(no, photo);
      else if (body.removePhoto) await photos.delete(no);
      return json({ car: publicView(next, key) });
    }
    const next = { ...car, photo: photo ? now : 0, key, parkedAt: now };
    const res = await store.setJSON(no, next, { onlyIfNew: true });
    if (res && res.modified === false) return json({ error: "Someone just took this bay." }, 409);
    if (photo) await photos.set(no, photo);
    else await photos.delete(no);
    return json({ car: publicView(next, key) }, 201);
  }

  if (req.method === "DELETE") {
    const existing = await store.get(no, { type: "json" });
    if (!existing) return json({ ok: true });
    if (existing.key !== key && !admin) return json({ error: "Only the driver can pull this car out." }, 403);
    await store.delete(no);
    await photos.delete(no);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: ["/api/bays", "/api/bays/:no", "/api/photos/:no"] };
