// An empty worker: what the per-task router costs when the task loads almost nothing.
export default {
  fetch: function () {
    return Response.json({ status: "ok" });
  },
};
