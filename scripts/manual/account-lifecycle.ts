import { withManualTestAccount } from "./utils.ts";

await withManualTestAccount(async (account) => {
  console.log("Temporary account is ready for manual testing:");
  console.log(JSON.stringify({
    accountId: account.accountId,
    username: account.username,
  }, null, 2));
});
