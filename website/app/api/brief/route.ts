import rawBrief from "../../../data/trends.json";

export const dynamic = "force-static";
export const revalidate = 300;

export function GET() {
  return new Response(JSON.stringify(rawBrief), {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"${rawBrief.generatedAt}"`,
    },
  });
}
