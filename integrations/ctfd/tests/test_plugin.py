"""Run with CTFd 3.8.2 on PYTHONPATH; uses only disposable in-memory CTFd data."""

import os
import tempfile
import unittest
from unittest.mock import patch

from CTFd.config import TestingConfig
from CTFd.models import Challenges, Flags, Solves, db
from CTFd.plugins.tenkacloud.runtime import RuntimeErrorResponse, evaluate, host_url, request_host, runtime
from CTFd.utils import set_config
from tests.helpers import create_ctfd, login_as_user, register_user


KEY = "a" * 43
EVENT_ID = "0" * 26
HOST_DATA = {
    "eventGate": {"kind": "ok"},
    "problems": [{
        "problemId": "ctfd-demo",
        "containerSession": {"status": "running"},
        "stackOutputs": {"Web": "http://127.0.0.1:5300/", "unsafe": "javascript:alert(1)"},
        "writeup": "private answer", "scoring": {"flag": "secret"},
    }],
    "team": {"loginKey": KEY, "eventId": EVENT_ID},
}


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"TENKACLOUD_PARTICIPANT_URL": "http://127.0.0.1:5185/api", "TENKACLOUD_EVENT_ID": EVENT_ID})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_fixed_origin_and_no_credential_url(self):
        self.assertEqual(host_url(), "http://127.0.0.1:5185/api")
        for value in ("", "http://example.com", "https://example.com/api", "https://x/other", "https://u:p@x", "https://x?target=y"):
            with self.subTest(value=value), patch.dict(os.environ, {"TENKACLOUD_PARTICIPANT_URL": value}):
                with self.assertRaises(RuntimeErrorResponse):
                    host_url()

    @patch("CTFd.plugins.tenkacloud.runtime.request_host", return_value=HOST_DATA)
    def test_projection_excludes_secrets_and_other_protocols(self, request):
        self.assertEqual(runtime("ctfd-demo", KEY, "read"), {
            "status": "running", "links": [{"name": "Web", "url": "http://127.0.0.1:5300/"}]
        })
        request.assert_called_once_with("GET", "/portal/me", KEY)

    @patch("CTFd.plugins.tenkacloud.runtime.request_host", return_value=HOST_DATA)
    def test_start_stop_use_only_owned_problem(self, request):
        for action in ("start", "stop"):
            self.assertEqual(runtime("ctfd-demo", KEY, action), {"status": "accepted"})
            request.assert_called_with("POST", f"/portal/me/problems/ctfd-demo/container/{action}", KEY)

    @patch("CTFd.plugins.tenkacloud.runtime.request_host", return_value=HOST_DATA)
    def test_wrong_team_and_selectors_cannot_mutate(self, request):
        with self.assertRaises(RuntimeErrorResponse) as caught:
            runtime("another-team-problem", KEY, "start")
        self.assertEqual(caught.exception.status, 403)
        request.assert_called_once()

    @patch("CTFd.plugins.tenkacloud.runtime.request_host")
    def test_input_validation_before_network(self, request):
        for problem, key, action in (("../admin", KEY, "start"), ("ctfd-demo", "bad", "read"), ("ctfd-demo", KEY, "delete")):
            with self.subTest(action=action), self.assertRaises(RuntimeErrorResponse):
                runtime(problem, key, action)
        request.assert_not_called()

    @patch("CTFd.plugins.tenkacloud.runtime.request_host")
    def test_event_gate_and_unsupported_runtime_fail_closed(self, request):
        for data in ({"problems": []}, {**HOST_DATA, "eventGate": {"kind": "scoring_ended"}},
                     {**HOST_DATA, "problems": [{"problemId": "ctfd-demo"}]}):
            request.return_value = data
            with self.assertRaises(RuntimeErrorResponse):
                runtime("ctfd-demo", KEY, "start")
            self.assertTrue(all(call.args[0] == "GET" for call in request.call_args_list))
            request.reset_mock()

    @patch("CTFd.plugins.tenkacloud.runtime.request_host")
    def test_stopped_environment_has_no_stale_links(self, request):
        request.return_value = {**HOST_DATA, "problems": [{**HOST_DATA["problems"][0], "containerSession": {"status": "stopped"}}]}
        self.assertEqual(runtime("ctfd-demo", KEY, "read"), {"status": "stopped", "links": []})

    @patch("CTFd.plugins.tenkacloud.runtime.request_host")
    def test_other_event_key_cannot_start_or_score_the_same_problem(self, request):
        request.return_value = {**HOST_DATA, "team": {"eventId": "1" * 26}}
        for action in (lambda: runtime("ctfd-demo", KEY, "start"), lambda: evaluate("ctfd-demo", KEY, "answer")):
            request.reset_mock()
            with self.assertRaises(RuntimeErrorResponse) as caught:
                action()
            self.assertEqual(caught.exception.status, 403)
            request.assert_called_once_with("GET", "/portal/me", KEY)

    @patch("CTFd.plugins.tenkacloud.runtime.requests.Session")
    def test_transport_refuses_redirects_and_sanitizes_upstream_errors(self, session):
        client = session.return_value.__enter__.return_value
        response = client.request.return_value.__enter__.return_value
        for upstream, expected in ((301, 502), (401, 401), (403, 403), (404, 404), (409, 409), (429, 429), (500, 502)):
            response.status_code = upstream
            with self.subTest(upstream=upstream), self.assertRaises(RuntimeErrorResponse) as caught:
                request_host("GET", "/portal/me", KEY)
            self.assertEqual(caught.exception.status, expected)
            self.assertNotIn(KEY, caught.exception.message)
        self.assertFalse(client.trust_env)
        self.assertFalse(client.request.call_args.kwargs["allow_redirects"])
        self.assertEqual(client.request.call_args.args[1], "http://127.0.0.1:5185/api/portal/me")

    @patch("CTFd.plugins.tenkacloud.runtime.requests.Session")
    def test_transport_bounds_response_and_rejects_invalid_json(self, session):
        response = session.return_value.__enter__.return_value.request.return_value.__enter__.return_value
        response.status_code = 200
        for chunks in ([b"not-json"], [b"x" * (1024 * 1024 + 1)]):
            response.iter_content.return_value = chunks
            with self.assertRaises(RuntimeErrorResponse) as caught:
                request_host("GET", "/portal/me", KEY)
            self.assertEqual(caught.exception.status, 502)

    @patch("CTFd.plugins.tenkacloud.runtime.requests.Session")
    def test_transport_timeout_and_network_error_do_not_expose_exception_text(self, session):
        import requests
        client = session.return_value.__enter__.return_value
        client.request.side_effect = requests.Timeout("private key=" + KEY)
        with self.assertRaises(RuntimeErrorResponse) as caught:
            request_host("POST", "/portal/me/problems/ctfd-demo/container/start", KEY)
        self.assertEqual(caught.exception.status, 502)
        self.assertNotIn(KEY, caught.exception.message)

    @patch("CTFd.plugins.tenkacloud.runtime.requests.Session")
    @patch("CTFd.plugins.tenkacloud.runtime.time.monotonic", side_effect=[0, 16])
    def test_slow_stream_has_total_deadline(self, now, session):
        response = session.return_value.__enter__.return_value.request.return_value.__enter__.return_value
        response.status_code = 200
        response.iter_content.return_value = [b"{}"]
        with self.assertRaises(RuntimeErrorResponse) as caught:
            request_host("GET", "/portal/me", KEY)
        self.assertEqual(caught.exception.status, 502)


class PluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="ctfd-plugin-tests-")
        TestingConfig.LOG_FOLDER = cls.directory.name
        TestingConfig.UPLOAD_FOLDER = cls.directory.name
        cls.app = create_ctfd(enable_plugins=True)
        register_user(cls.app)
        cls.admin = login_as_user(cls.app, "admin")
        cls.user = login_as_user(cls.app, "user")

    @classmethod
    def tearDownClass(cls):
        with cls.app.app_context():
            db.session.remove()
            db.engine.dispose()
        cls.directory.cleanup()

    def setUp(self):
        with self.app.app_context():
            set_config("start", None)
            set_config("end", None)
            set_config("paused", False)
            set_config("verify_emails", False)
            set_config("user_mode", "users")
        response = self.admin.post("/api/v1/challenges", json={
            "name": "Environment", "category": "Test", "description": "Isolated challenge",
            "value": 100, "type": "tenkacloud", "connection_info": "ctfd-demo", "state": "visible",
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.challenge_id = response.json["data"]["id"]
        self.path = f"/plugins/tenkacloud/runtime/{self.challenge_id}/read"

    def tearDown(self):
        self.admin.delete(f"/api/v1/challenges/{self.challenge_id}")

    @patch("CTFd.plugins.tenkacloud.runtime", return_value={"status": "stopped", "links": []})
    def test_real_challenge_render_and_runtime(self, run):
        response = self.user.get(f"/api/v1/challenges/{self.challenge_id}")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Start environment", response.json["data"]["view"])
        response = self.user.post(self.path, json={"team_key": KEY})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        run.assert_called_once_with("ctfd-demo", KEY, "read")

    @patch("CTFd.plugins.tenkacloud.runtime")
    def test_no_anonymous_or_missing_csrf_access(self, run):
        client = self.app.test_client()
        self.assertIn(client.post(self.path, json={"team_key": KEY}).status_code, (302, 403))
        # Use Flask's underlying client to avoid the CTFd test helper automatically adding CSRF.
        from flask.testing import FlaskClient
        with self.user.session_transaction() as session:
            session["nonce"] = "known-nonce"
        result = FlaskClient.open(self.user, self.path, method="POST", json={"team_key": KEY})
        self.assertEqual(result.status_code, 403)
        run.assert_not_called()

    @patch("CTFd.plugins.tenkacloud.runtime")
    def test_hidden_locked_paused_ended_and_prerequisites(self, run):
        with self.app.app_context():
            challenge = Challenges.query.get(self.challenge_id)
            challenge.state = "hidden"
            db.session.commit()
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 404)
        with self.app.app_context():
            challenge = Challenges.query.get(self.challenge_id)
            challenge.state = "locked"
            db.session.commit()
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        with self.app.app_context():
            challenge = Challenges.query.get(self.challenge_id)
            challenge.state = "visible"
            challenge.requirements = {"prerequisites": [self.challenge_id]}
            db.session.commit()
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        with self.app.app_context():
            challenge = Challenges.query.get(self.challenge_id)
            challenge.requirements = None
            db.session.commit()
            set_config("paused", True)
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        with self.app.app_context():
            set_config("paused", False)
            set_config("end", 1)
            set_config("view_after_ctf", True)
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        run.assert_not_called()

    @patch("CTFd.plugins.tenkacloud.runtime")
    def test_reject_extra_selectors_and_error_is_sanitized(self, run):
        response = self.user.post(self.path, json={"team_key": KEY, "url": "http://metadata/"})
        self.assertEqual(response.status_code, 400)
        run.assert_not_called()
        run.side_effect = RuntimeErrorResponse(502, "TenkaCloud is unreachable.")
        response = self.user.post(self.path, json={"team_key": KEY})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(KEY, response.get_data(as_text=True))

    @patch("CTFd.plugins.tenkacloud.runtime")
    def test_ctfd_team_membership_and_verified_email_are_required(self, run):
        with self.app.app_context():
            set_config("user_mode", "teams")
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        with self.app.app_context():
            set_config("user_mode", "users")
            set_config("verify_emails", True)
        self.assertEqual(self.user.post(self.path, json={"team_key": KEY}).status_code, 403)
        run.assert_not_called()

    def test_ctfd_alone_scores_wrong_correct_and_duplicate_flags(self):
        with self.app.app_context():
            db.session.add(Flags(challenge_id=self.challenge_id, type="static", content="TC{isolated-test}"))
            db.session.commit()
        submit = lambda flag: self.user.post("/api/v1/challenges/attempt", json={
            "challenge_id": self.challenge_id, "submission": flag,
        }).json["data"]["status"]
        self.assertEqual(submit("wrong"), "incorrect")
        self.assertEqual(submit("TC{isolated-test}"), "correct")
        self.assertEqual(submit("TC{isolated-test}"), "already_solved")
        with self.app.app_context():
            self.assertEqual(Solves.query.filter_by(challenge_id=self.challenge_id).count(), 1)

    @patch("CTFd.plugins.tenkacloud.evaluate")
    def test_container_verdict_scores_only_in_ctfd_and_transport_failure_is_not_wrong_flag(self, evaluate):
        from CTFd.models import Fails
        with self.app.app_context():
            self.assertEqual(Flags.query.filter_by(challenge_id=self.challenge_id).count(), 0)
        evaluate.side_effect = RuntimeErrorResponse(502, "Verifier is unavailable.")
        submit = lambda flag: self.user.post("/api/v1/challenges/attempt", json={
            "challenge_id": self.challenge_id, "submission": flag, "team_key": KEY,
        })
        self.assertEqual(submit("answer").status_code, 502)
        with self.app.app_context():
            self.assertEqual(Fails.query.filter_by(challenge_id=self.challenge_id).count(), 0)
            self.assertEqual(Solves.query.filter_by(challenge_id=self.challenge_id).count(), 0)
        evaluate.side_effect = [False, True]
        self.assertEqual(submit("wrong").json["data"]["status"], "incorrect")
        self.assertEqual(submit("correct").json["data"]["status"], "correct")
        evaluate.assert_called_with("ctfd-demo", KEY, "correct")
        with self.app.app_context():
            self.assertEqual(Fails.query.filter_by(challenge_id=self.challenge_id).count(), 1)
            self.assertEqual(Solves.query.filter_by(challenge_id=self.challenge_id).count(), 1)


if __name__ == "__main__":
    unittest.main()
