interface SchedulerEnv {
  BID_RUN_URL: string;
  BID_SCHEDULER_SECRET: string;
}

interface SchedulerController {
  cron: string;
  scheduledTime: number;
}

const scheduler = {
  async scheduled(controller: SchedulerController, env: SchedulerEnv) {
    const response = await fetch(env.BID_RUN_URL, {
      method: "POST",
      headers: { "x-bid-scheduler-secret": env.BID_SCHEDULER_SECRET },
    });

    if (!response.ok) {
      throw new Error(`Bidding endpoint returned ${response.status} for ${controller.cron}.`);
    }
  },

  async fetch() {
    return new Response("Auto Auctioneer scheduler is online.", { status: 200 });
  },
};

export default scheduler;
