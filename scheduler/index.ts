export interface SchedulerEnv {
  BID_RUN_URL: string;
  BID_SCHEDULER_SECRET: string;
}

export interface SchedulerController {
  cron: string;
  scheduledTime: number;
}

const scheduler = {
  async scheduled(controller: SchedulerController, env: SchedulerEnv) {
    const response = await fetch(env.BID_RUN_URL, {
      method: "POST",
      headers: { "x-bid-scheduler-secret": env.BID_SCHEDULER_SECRET },
    });

    if (response.status === 503) {
      const body = await response.text().catch(() => "");
      if (body.includes('"enabled":false')) return;
    }
    if (!response.ok) {
      throw new Error(`Bidding endpoint returned ${response.status} for ${controller.cron}.`);
    }
  },

  async fetch() {
    return new Response("Auto Auctioneer scheduler is online.", { status: 200 });
  },
};

export default scheduler;
