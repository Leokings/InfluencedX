const response = () => Response.json(
  {
    error: {
      code: "GENLAYER_NATIVE_METRICS_NOT_AVAILABLE",
      message: "Creator metrics are not part of the current GenLayer-native marketplace contract.",
    },
  },
  { status: 410, headers: { "Cache-Control": "public, max-age=300" } },
);

export const dynamic = "force-dynamic";
export async function GET() { return response(); }
export async function POST() { return response(); }
