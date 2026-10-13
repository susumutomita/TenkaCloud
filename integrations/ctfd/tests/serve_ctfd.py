"""Disposable real CTFd application for the browser rehearsal."""
import os
import secrets
import tempfile

os.environ["SECRET_KEY"] = secrets.token_hex(32)

from CTFd.config import TestingConfig
from CTFd.models import Flags, db
from CTFd.utils import set_config
from tests.helpers import create_ctfd, login_as_user, register_user

with tempfile.TemporaryDirectory(prefix="tenka-ctfd-browser-") as directory:
    TestingConfig.LOG_FOLDER = directory
    TestingConfig.UPLOAD_FOLDER = directory
    TestingConfig.SERVER_NAME = None
    app = create_ctfd(enable_plugins=True, password="isolated-rehearsal-only", ctf_theme=os.environ.get("CTFD_E2E_THEME", "core"))
    register_user(app, password="isolated-rehearsal-only")
    with app.app_context():
        set_config("challenge_ratings", "disabled")
        set_config("ctf_name", "TenkaCloud CTFd rehearsal")
    admin = login_as_user(app, "admin", "isolated-rehearsal-only")
    response = admin.post("/api/v1/challenges", json={
        "name": "CTFd isolated exercise", "category": "Local", "value": 100,
        "description": "Start your own environment, find its flag, and submit it below.",
        "type": "tenkacloud", "connection_info": os.environ.get("CTFD_E2E_PROBLEM_ID", "ctfd-demo"), "state": "visible", "max_attempts": 3,
    })
    assert response.status_code == 200, response.get_data(as_text=True)
    # No CTFd Flags row: the challenge checks the owned container's verdict, and CTFd records its score.
    standard = admin.post("/api/v1/challenges", json={
        "name": "Standard regression", "category": "Regression", "value": 5,
        "description": "Standard CTFd scoring remains available.", "type": "standard", "state": "visible",
    })
    assert standard.status_code == 200
    with app.app_context():
        db.session.add(Flags(challenge_id=standard.json["data"]["id"], type="static", content="TC{standard-fixture}"))
        db.session.commit()
    app.run(host="127.0.0.1", port=int(os.environ["CTFD_E2E_PORT"]), threaded=True, use_reloader=False)
