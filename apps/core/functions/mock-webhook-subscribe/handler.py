"""
Mock webhook subscription lambda for testing inbound webhooks.
Logs all received events and validates the webhook secret signature.
"""

import hashlib
import hmac
import json
import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def validate_signature(body: str, signature_header: str) -> bool:
    secret = os.environ.get("MOCK_WEBHOOK_SECRET")
    if not secret:
        logger.warning("WEBHOOK_SECRET not configured")
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    expected_signature = f"sha256={expected}"
    return hmac.compare_digest(signature_header, expected_signature)

def handler(event, context):
    logger.info("Received webhook event: %s", json.dumps(event, default=str))

    body = event.get("body", "{}")
    if isinstance(body, str):
        try:
            parsed_body = json.loads(body)
        except json.JSONDecodeError:
            parsed_body = body
    else:
        parsed_body = body

    signature = event.get("headers", {}).get("x-webhook-signature", "")

    if not signature:
        logger.warning("Missing X-Webhook-Signature header")
        return {
            "statusCode": 401,
            "body": json.dumps({"error": "missing webhook signature"}),
        }

    if not validate_signature(body, signature):
        logger.warning("Invalid webhook signature")
        return {
            "statusCode": 403,
            "body": json.dumps({"error": "invalid webhook signature"}),
        }

    logger.info("Webhook signature validated successfully")
    logger.info("Webhook payload: %s", json.dumps(parsed_body, default=str))

    return {
        "statusCode": 200,
        "body": json.dumps({
            "status": "received",
            "message": "webhook payload logged successfully",
        }),
    }
