import rawNicheBrief from "../../../data/niche-trends.json";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return new Response(JSON.stringify(rawNicheBrief), {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"${rawNicheBrief.generatedAt}"`,
    },
  });
}
