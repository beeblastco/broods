import { query } from "./_generated/server";

/** Returns an empty list as a health-check query. */
export const ping = query({
    args: {},
    handler: async () => {
        return "pong";
    },
});
