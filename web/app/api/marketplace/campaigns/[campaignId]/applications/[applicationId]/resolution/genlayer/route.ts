import { apiError, ApiProblem } from "@/lib/verification-api";

export const dynamic = "force-dynamic";
export async function POST() {
  return apiError(new ApiProblem(
    410,
    "HISTORICAL_BRIDGE_RETIRED",
    "This bridge is retired. Use the native StudioNet resolution endpoint.",
  ));
}
