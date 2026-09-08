#!/usr/bin/env python3
"""Synthetic app-server peer for isolated desktop smoke tests. Never uses credentials."""
import json
import os
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    params = request.get("params", {})
    now = int(time.time())
    if method == "initialize":
        result = {"userAgent": f"{params['clientInfo']['name']}/0.153.4", "codexHome": os.environ.get("CODEX_HOME")}
    elif method == "account/read":
        result = {"account": {"type": "chatgpt", "email": "Demo account", "planType": "pro"}, "requiresOpenaiAuth": True}
    elif method == "account/rateLimits/read":
        result = {"accountId": "synthetic-demo-account", "rateLimitsByLimitId": {
            "codex": {"limitId": "codex", "planType": "pro", "primary": {"usedPercent": 34, "windowDurationMins": 300, "resetsAt": now + 8400}, "secondary": {"usedPercent": 62, "windowDurationMins": 10080, "resetsAt": now + 345600}, "credits": {"hasCredits": True, "unlimited": False, "balance": "25"}},
            "review": {"limitId": "review", "limitName": "Code review", "primary": {"usedPercent": 18, "windowDurationMins": 10080, "resetsAt": now + 345600}}
        }, "rateLimitResetCredits": {"availableCount": 1}}
    elif method == "account/usage/read":
        result = {"summary": {"lifetimeTokens": 8240000, "peakDailyTokens": 510000, "longestRunningTurnSec": 940, "currentStreakDays": 8, "longestStreakDays": 16}, "dailyUsageBuckets": [{"startDate": time.strftime("%Y-%m-%d", time.gmtime(now - (6 - i) * 86400)), "tokens": n} for i, n in enumerate([140000, 290000, 180000, 510000, 320000, 225000, 180000])]}
        if params.get("threadId"):
            result["threadUsage"] = {"threadId": params["threadId"], "estimatedUsageCreditsMicros": 1250000, "estimatedUsageUsdMicros": None, "groups": [{"model": "gpt-6", "reasoningEffort": "high", "inputTokens": 75000, "cachedInputTokens": 24000, "outputTokens": 8900, "totalTokens": 83900, "estimatedUsageCreditsMicros": 1250000}]}
            if params["threadId"] == "demo-2":
                result["threadUsage"] = None
    elif method == "thread/list":
        result = {"data": [{"id": f"demo-{i}", "name": name, "cwd": f"/home/demo/dev/{project}", "model": "gpt-6", "reasoningEffort": "high", "updatedAt": now - offset, "source": "cli"} for i, (name, project, offset) in enumerate([("Improve account refresh", "usage-monitor", 120), ("Review authentication changes", "gateway", 3600), ("Fix the release workflow", "website", 7200)])], "nextCursor": None}
    else:
        print(json.dumps({"id": request["id"], "error": {"code": -32601, "message": "Fixture method unavailable"}}), flush=True)
        continue
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
