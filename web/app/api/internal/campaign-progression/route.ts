import {
  genLayerProgressionRequestIsAuthorized,
} from "@/lib/marketplace-genlayer-progression";
import {
  enqueueMarketplaceMaintenanceHeartbeat,
} from "@/lib/marketplace-genlayer-maintenance-queue";
import {
  MarketplaceMaintenanceGenerationConflictError,
  marketplaceMaintenanceDeploymentContext,
  promoteMarketplaceMaintenanceGeneration,
  readMarketplaceMaintenanceGeneration,
} from "@/lib/marketplace-genlayer-maintenance-generation";
import { ApiProblem, apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  return handleMaintenanceSeed(request, false);
}

export async function POST(request: Request) {
  return handleMaintenanceSeed(request, true);
}

async function handleMaintenanceSeed(request: Request, promote: boolean) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    return Response.json(
      {
        error: {
          code: "CRON_CONFIGURATION_REQUIRED",
          message: "Automatic campaign progression is not configured.",
        },
      },
      { status: 503, headers },
    );
  }
  if (!genLayerProgressionRequestIsAuthorized(request, secret)) {
    return Response.json(
      {
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "This campaign progression endpoint is not public.",
        },
      },
      { status: 401, headers },
    );
  }

  try {
    const context = marketplaceMaintenanceDeploymentContext();
    const current = await readMarketplaceMaintenanceGeneration({ context });
    if (!promote && current?.deploymentId !== context.deploymentId) {
      return Response.json(
        {
          error: {
            code: "MAINTENANCE_GENERATION_INACTIVE",
            message: "This deployment is not the active maintenance generation.",
            currentGeneration: current?.generation ?? 0,
          },
        },
        { status: 409, headers },
      );
    }
    const activation = promote
      ? await promoteMarketplaceMaintenanceGeneration(
          {
            expectedGeneration: expectedGenerationPrecondition(request),
          },
          { context },
        )
      : { generation: current!, promoted: false };
    const heartbeat = await enqueueMarketplaceMaintenanceHeartbeat();
    return Response.json(
      {
        activation: {
          generation: activation.generation.generation,
          promoted: activation.promoted,
          active: true,
        },
        heartbeat,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof MarketplaceMaintenanceGenerationConflictError) {
      return Response.json(
        {
          error: {
            code: "MAINTENANCE_GENERATION_CONFLICT",
            message: "The maintenance generation changed; observe it again before retrying.",
          },
        },
        { status: 409, headers },
      );
    }
    return apiError(error);
  }
}

function expectedGenerationPrecondition(request: Request): number {
  const value = request.headers
    .get("x-influencedx-maintenance-generation")
    ?.trim();
  if (!value || !/^(0|[1-9][0-9]{0,14})$/.test(value)) {
    throw new ApiProblem(
      400,
      "MAINTENANCE_GENERATION_PRECONDITION_REQUIRED",
      "x-influencedx-maintenance-generation must contain the observed generation.",
    );
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new ApiProblem(
      400,
      "MAINTENANCE_GENERATION_PRECONDITION_REQUIRED",
      "The maintenance generation precondition is invalid.",
    );
  }
  return generation;
}
