export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(
    {
      error: {
        code: "HISTORICAL_BASE_INTENT_RETIRED",
        message: "This historical Base ownership-intent endpoint is retired. Use /api/verification/activation.",
      },
    },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
