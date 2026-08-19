export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(
    {
      error: {
        code: "HISTORICAL_SUBMITTER_RETIRED",
        message: "This historical relayed submitter endpoint is retired. Confirm the user-signed GenLayer activation instead.",
      },
    },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
