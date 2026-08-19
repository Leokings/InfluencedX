export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  return Response.json(
    {
      error: {
        code: "HISTORICAL_BASE_RELAY_RETIRED",
        message: "The Base relay authorization boundary is retired in the GenLayer-native product.",
      },
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
