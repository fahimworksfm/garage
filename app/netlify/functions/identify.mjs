import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// Reads a car photo and returns settings for the garage's 3D car.
// Credentials come from Netlify AI Gateway (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL are injected).

const CarReading = z.object({
  is_vehicle: z.boolean().describe("true if the photo clearly shows a car, SUV, pickup or similar road vehicle"),
  make: z.string().describe("Manufacturer, e.g. BMW. Empty string if unsure."),
  model: z.string().describe("Model name without the make, e.g. 430i Gran Coupe. Empty string if unsure."),
  year: z.string().describe("Four-digit model year if you can tell, otherwise empty string."),
  body: z.enum(["coupe", "sedan", "hatch", "suv", "truck"]).describe("Closest body style."),
  paint_hex: z.string().describe("Main body paint colour as #RRGGBB, judged under neutral light."),
  finish: z.enum(["gloss", "matte", "metal"]).describe("gloss for normal paint, matte for flat/satin wraps, metal for visibly metallic or pearl paint."),
  confidence: z.enum(["high", "medium", "low"]),
});

const SYSTEM = `You identify cars from photos for a casual car-parking garage game.
Look at the main vehicle in the photo and report its make, model, model year, body style, main paint colour and paint finish.
Body style mapping: two-door or fastback sports cars and gran coupes -> coupe; four-door saloons -> sedan; small cars with a rear hatch and wagons -> hatch; SUVs and crossovers -> suv; pickups and vans -> truck.
For paint, give the colour of the bodywork itself, not reflections, windows or wheels. Very dark paint is fine to report as near-black.
Only name a make or model you can actually see evidence for (badges, grille, lights, shape); otherwise leave it empty and lower the confidence.`;

const recent = new Map(); // best-effort per-instance limiter: driver key -> timestamps
const LIMIT = 8, WINDOW_MS = 10 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!process.env.ANTHROPIC_API_KEY)
    return json({ error: "Photo reading isn't switched on for this garage yet. Fill your car in below." }, 503);

  const key = (req.headers.get("x-driver-key") || "").slice(0, 64);
  if (key.length < 16) return json({ error: "Missing driver key." }, 400);
  const now = Date.now();
  const hits = (recent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= LIMIT) return json({ error: "That's a lot of photos. Try again in a few minutes." }, 429);
  hits.push(now); recent.set(key, hits);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Send the photo as JSON." }, 400); }
  const image = typeof body?.image === "string" ? body.image : "";
  if (!/^[A-Za-z0-9+/=]+$/.test(image) || image.length < 1000) return json({ error: "That photo didn't come through. Try another." }, 400);
  if (image.length > 2_000_000) return json({ error: "That photo is too large." }, 413);

  const client = new Anthropic();
  try {
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(CarReading) },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: "Identify this car for the garage." },
        ],
      }],
    });

    if (response.stop_reason === "refusal") return json({ error: "Couldn't read that photo. Fill your car in below." }, 422);
    const r = response.parsed_output;
    if (!r) return json({ error: "Couldn't read that photo. Fill your car in below." }, 422);
    if (!r.is_vehicle) return json({ error: "That doesn't look like a car. Try a photo with the whole car in it." }, 422);

    return json({
      make: r.make.slice(0, 20),
      model: r.model.slice(0, 24),
      year: /^\d{4}$/.test(r.year) ? r.year : "",
      body: r.body,
      paint: /^#[0-9a-fA-F]{6}$/.test(r.paint_hex) ? r.paint_hex.toUpperCase() : null,
      finish: r.finish,
      confidence: r.confidence,
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: "Photo reading is busy. Try again in a minute." }, 429);
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
      return json({ error: "Photo reading isn't switched on for this garage yet. Fill your car in below." }, 503);
    if (error instanceof Anthropic.BadRequestError) return json({ error: "Couldn't read that photo. Try a different one." }, 422);
    if (error instanceof Anthropic.APIError) { console.error("anthropic", error.status, error.message); return json({ error: "Photo reading failed. Try again." }, 502); }
    console.error("identify", error);
    return json({ error: "Photo reading failed. Try again." }, 500);
  }
};

export const config = { path: "/api/identify" };
