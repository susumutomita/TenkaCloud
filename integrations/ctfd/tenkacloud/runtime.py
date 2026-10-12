"""Bounded client for the existing participant API. No stored credentials."""

import json
import os
import re
import time
from urllib.parse import urlsplit

import requests

PROBLEM_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,127}\Z")
TEAM_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
MAX_RESPONSE = 1024 * 1024


class RuntimeErrorResponse(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def host_url():
    value = os.environ.get("TENKACLOUD_PARTICIPANT_URL", "").rstrip("/")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/api")
        or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
    ):
        raise RuntimeErrorResponse(503, "The organizer must configure the participant API URL.")
    return value


def request_host(method, path, key, body=None):
    # Only operator-controlled origin and fixed participant routes; never an arbitrary proxy.
    started = time.monotonic()
    try:
        with requests.Session() as client:
            client.trust_env = False
            with client.request(
                method,
                host_url() + path,
                headers={"Authorization": "Bearer " + key},
                json=(body if body is not None else {}) if method == "POST" else None,
                timeout=(3, 10),
                allow_redirects=False,
                stream=True,
            ) as response:
                if response.status_code not in (200, 202):
                    status = response.status_code
                    if status in (401, 403):
                        raise RuntimeErrorResponse(status, "The team key was rejected by TenkaCloud.")
                    if status in (404, 409, 429):
                        raise RuntimeErrorResponse(status, "Environment unavailable or busy; refresh or ask the organizer.")
                    raise RuntimeErrorResponse(502, "TenkaCloud could not complete the request.")
                raw = bytearray()
                for chunk in response.iter_content(16384):
                    if time.monotonic() - started > 15:
                        raise RuntimeErrorResponse(502, "TenkaCloud response timed out.")
                    raw.extend(chunk)
                    if len(raw) > MAX_RESPONSE:
                        raise RuntimeErrorResponse(502, "TenkaCloud response exceeded the size limit.")
                return json.loads(raw)
    except (requests.RequestException, ValueError):
        raise RuntimeErrorResponse(502, "TenkaCloud is unreachable or returned an invalid response.") from None


def runtime(problem_id, key, action):
    if not isinstance(key, str) or not TEAM_KEY.fullmatch(key):
        raise RuntimeErrorResponse(400, "Enter the existing TenkaCloud team login key.")
    if not isinstance(problem_id, str) or not PROBLEM_ID.fullmatch(problem_id):
        raise RuntimeErrorResponse(503, "The organizer must set a valid TenkaCloud problem ID.")
    if action not in ("read", "start", "stop"):
        raise RuntimeErrorResponse(404, "Unknown environment action.")
    event_id = os.environ.get("TENKACLOUD_EVENT_ID", "")
    if not re.fullmatch(r"[0-9A-Z]{26}", event_id):
        raise RuntimeErrorResponse(503, "The organizer must configure the TenkaCloud event ID.")
    # Problem-scoped: the whole-team view would issue a link for every running environment.
    data = request_host("GET", f"/portal/me/problems/{problem_id}", key)
    if not isinstance(data, dict) or not isinstance(data.get("problems"), list):
        raise RuntimeErrorResponse(502, "TenkaCloud returned an invalid problem list.")
    team = data.get("team")
    if not isinstance(team, dict) or team.get("eventId") != event_id:
        raise RuntimeErrorResponse(403, "This key belongs to another TenkaCloud event.")
    problem = next(
        (p for p in data["problems"] if isinstance(p, dict) and p.get("problemId") == problem_id),
        None,
    )
    if problem is None:
        raise RuntimeErrorResponse(403, "This problem is not assigned to your TenkaCloud team.")
    gate = data.get("eventGate", {})
    if not isinstance(gate, dict) or gate.get("kind") != "ok":
        raise RuntimeErrorResponse(409, "The TenkaCloud event is not currently open.")
    state = problem.get("containerSession")
    if not isinstance(state, dict) or state.get("status") not in (
        "stopped", "starting", "running", "stopping", "error"
    ):
        raise RuntimeErrorResponse(409, "This challenge requires an on-demand Docker environment.")
    if action != "read":
        request_host("POST", f"/portal/me/problems/{problem_id}/container/{action}", key)
        return {"status": "accepted"}
    # Do not forward team keys, hints, flags, writeups, scoring, or unrelated problems.
    outputs = problem.get("stackOutputs", {}) if state["status"] == "running" else {}
    links = []
    if isinstance(outputs, dict):
        for name, value in outputs.items():
            if not isinstance(value, str):
                continue
            try:
                parsed = urlsplit(value)
                if parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password:
                    links.append({"name": str(name), "url": value})
            except ValueError:
                continue
    if state["status"] == "running" and problem.get("accessError"):
        # The environment runs but the host could not issue its link; never report that as ready.
        return {"status": "running", "links": [], "accessError": "link_unavailable"}
    return {"status": state["status"], "links": links}


def evaluate(problem_id, key, submission):
    if not isinstance(submission, str) or len(submission.encode("utf-8")) > 60 * 1024:
        raise RuntimeErrorResponse(400, "The flag submission is invalid or too large.")
    submission = submission.strip()
    state = runtime(problem_id, key, "read")
    if state["status"] != "running":
        raise RuntimeErrorResponse(409, "Start your environment before submitting a flag.")
    verdict = request_host("POST", f"/portal/me/problems/{problem_id}/evaluate", key, {"submission": submission})
    if not isinstance(verdict, dict) or type(verdict.get("correct")) is not bool:
        raise RuntimeErrorResponse(502, "TenkaCloud returned an invalid verdict.")
    return verdict["correct"]
