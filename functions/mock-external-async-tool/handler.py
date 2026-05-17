# Mock external async tool lambda function to test
# the external-dispatch feature
# Remove that from the sst.config.ts if you don't want to deploy this

import json
import time
import urllib.request

def handler(event, context):
    body = json.loads(event.get("body", "{}"))
    message = body.get("message", "")
    complete_url = body.get("completeUrl")

    if not complete_url:
        return {"statusCode": 400, "body": json.dumps({"error": "completeUrl required"})}

    time.sleep(3)
    result = f"hello {message}"

    # Simplified urllib POST
    req = urllib.request.Request(
        complete_url,
        data=json.dumps({"status": "completed", "response": {"result": result}}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=10)

    return {"statusCode": 200, "body": json.dumps({"result": result})}