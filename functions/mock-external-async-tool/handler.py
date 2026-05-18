"""
Mock external async tool lambda for the external-dispatch fixture.
Keep callback simulation here; production tools should own their worker code.
"""

import json
import time
import urllib.error
import urllib.request

def handler(event, context):
    body = json.loads(event.get("body", "{}"))
    message = body.get("message", "")
    complete_url = body.get("completeUrl")
    completion_headers = body.get("completionHeaders", {})

    if not complete_url:
        return {"statusCode": 400, "body": json.dumps({"error": "completeUrl required"})}
    if not isinstance(completion_headers, dict):
        return {"statusCode": 400, "body": json.dumps({"error": "completionHeaders must be an object"})}

    time.sleep(3)
    result = f"hello {message}"
    headers = {"Content-Type": "application/json"}
    headers.update({key: value for key, value in completion_headers.items() if isinstance(key, str) and isinstance(value, str)})

    req = urllib.request.Request(
        complete_url,
        data=json.dumps({
            "status": "completed", 
            "response": result
        }).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            response.read()
    except urllib.error.HTTPError as err:
        return {
            "statusCode": 502,
            "body": json.dumps({
                "error": "completion callback failed",
                "statusCode": err.code,
                "body": err.read().decode("utf-8", errors="replace"),
            }),
        }

    return {"statusCode": 200, "body": json.dumps({"result": result})}
