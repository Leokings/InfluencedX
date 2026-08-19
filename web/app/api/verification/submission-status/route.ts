export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      error: {
        code: "HISTORICAL_SUBMITTER_RETIRED",
        message: "This historical relayed submitter status endpoint is retired. Use /api/verification/status.",
      },
    },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
