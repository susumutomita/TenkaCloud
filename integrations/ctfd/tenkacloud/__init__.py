"""CTFd owns participants and scores; TenkaCloud owns the exercise runtime."""

from flask import Blueprint, abort, jsonify, request

from CTFd.models import Challenges, Flags, Solves
from CTFd.plugins import register_plugin_assets_directory
from CTFd.plugins.challenges import CHALLENGE_CLASSES, CTFdStandardChallenge
from CTFd.utils import config
from CTFd.utils.dates import ctf_paused, ctftime
from CTFd.utils.decorators import authed_only, require_verified_emails
from CTFd.utils.decorators.visibility import check_challenge_visibility
from CTFd.utils.user import get_current_team, get_current_user, is_admin

from .runtime import RuntimeErrorResponse, evaluate, runtime


class TenkaCloudChallenge(Challenges):
    # Single-table inheritance: no new database or mapping/credential table.
    __mapper_args__ = {"polymorphic_identity": "tenkacloud"}


class TenkaCloudChallengeType(CTFdStandardChallenge):
    id = "tenkacloud"
    name = "TenkaCloud (on-demand Docker)"
    challenge_model = TenkaCloudChallenge
    templates = {
        "create": "/plugins/tenkacloud/assets/create.html",
        "update": "/plugins/tenkacloud/assets/update.html",
        "view": "/plugins/tenkacloud/assets/view.html",
    }
    scripts = {
        **CTFdStandardChallenge.scripts,
        "view": "/plugins/tenkacloud/assets/view.js",
    }

    @classmethod
    def attempt(cls, challenge, request):
        if Flags.query.filter_by(challenge_id=challenge.id).count():
            return super().attempt(challenge, request)
        data = request.form or request.get_json(silent=True) or {}
        try:
            correct = evaluate(challenge.connection_info, data.get("team_key"), data.get("submission"))
        except RuntimeErrorResponse as error:
            # A transport/gate failure is not a wrong flag and must not create a CTFd fail record.
            abort(error.status, description=error.message)
        return correct, "Correct" if correct else "Incorrect"


def accessible_challenge(challenge_id):
    challenge = Challenges.query.filter_by(id=challenge_id, type="tenkacloud").first_or_404()
    if not is_admin():
        if challenge.state == "hidden":
            abort(404)
        if challenge.state == "locked" or not ctftime() or ctf_paused():
            abort(403)
        if config.is_teams_mode() and get_current_team() is None:
            abort(403)
        all_ids = {c.id for c in Challenges.query.with_entities(Challenges.id).all()}
        prerequisites = set((challenge.requirements or {}).get("prerequisites", [])).intersection(all_ids)
        solved = {
            c for c, in Solves.query.with_entities(Solves.challenge_id)
            .filter_by(account_id=get_current_user().account_id).all()
        }
        if not solved.issuperset(prerequisites):
            abort(403)
    return challenge


def load(app):
    CHALLENGE_CLASSES[TenkaCloudChallengeType.id] = TenkaCloudChallengeType
    register_plugin_assets_directory(app, base_path="/plugins/tenkacloud/assets/")
    blueprint = Blueprint("tenkacloud_runtime", __name__)

    @blueprint.route("/plugins/tenkacloud/runtime/<int:challenge_id>/<action>", methods=["POST"])
    @authed_only
    @require_verified_emails
    @check_challenge_visibility
    def environment(challenge_id, action):
        challenge = accessible_challenge(challenge_id)
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {"team_key"}:
            return jsonify(success=False, message="Supply only a team login key."), 400
        try:
            data = runtime(challenge.connection_info, body["team_key"], action)
            response = jsonify(success=True, data=data)
            response.headers["Cache-Control"] = "no-store"
            return response
        except RuntimeErrorResponse as error:
            return jsonify(success=False, message=error.message), error.status

    app.register_blueprint(blueprint)
