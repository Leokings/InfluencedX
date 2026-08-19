export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(
    {
      error: {
        code: "IDENTITY_BUNDLE_REQUIRED",
        message: "Create the X and Farcaster challenges together.",
      },
    },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
