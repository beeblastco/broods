import { defineFilthyPanty } from "filthy-panty";

export default defineFilthyPanty({
  project: "filthy-panty-demos",
  environments: {
    dev: "development",
    deploy: "production",
  },
  dashboardUrl: process.env.FILTHY_PANTY_DASHBOARD_URL ?? "https://dashboard.dev.beeblast.co",
});
