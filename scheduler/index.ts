export interface SchedulerEnv {
  BID_RUN_URL: string;
  BID_SCHEDULER_SECRET: string;
  FINDER_TICK_URL?: string;
  VERCEL_PROTECTION_BYPASS_SECRET?: string;
}

export interface SchedulerController {
  cron: string;
  scheduledTime: number;
}

function schedulerHeaders(env: SchedulerEnv): HeadersInit {
  const headers: Record<string, string> = { "x-bid-scheduler-secret": env.BID_SCHEDULER_SECRET };
  if (env.VERCEL_PROTECTION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_PROTECTION_BYPASS_SECRET;
  return headers;
}

const scheduler = {
  async scheduled(controller: SchedulerController, env: SchedulerEnv) {
    const bidResponse = await fetch(env.BID_RUN_URL, {
      method: "POST",
      headers: schedulerHeaders(env),
    });

    if (bidResponse.status === 503) {
      const body = await bidResponse.text().catch(() => "");
      if (!body.includes('"enabled":false')) throw new Error(`Bidding endpoint returned ${bidResponse.status} for ${controller.cron}.`);
    } else if (!bidResponse.ok) {
      throw new Error(`Bidding endpoint returned ${bidResponse.status} for ${controller.cron}.`);
    }

    if (env.FINDER_TICK_URL) {
      const finderResponse = await fetch(env.FINDER_TICK_URL, {
        method: "POST",
        headers: schedulerHeaders(env),
      });
      if (!finderResponse.ok) throw new Error(`Finder endpoint returned ${finderResponse.status} for ${controller.cron}.`);
    }
  },

  async fetch() {
    return new Response("Auto Auctioneer scheduler is online.", { status: 200 });
  },
};

export default scheduler;
