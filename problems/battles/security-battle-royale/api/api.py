# =====================================================================
# WARNING — INTENTIONALLY VULNERABLE CODE
# このファイルは Battle 競技問題 "security-battle-royale" の被攻撃対象 API
# として意図的に SQL injection / SSRF / RCE / debug-mode 等を含んでいる。
# プレイヤーがこれらの脆弱性を攻撃することで採点 endpoint を落とすゲーム性。
# CodeQL / 静的解析からの警告は「ゲームプレイの一部」として dismiss される。
# 本番アプリのコードとして参考にしないこと。
# =====================================================================
import json
import logging
import os
import subprocess
from pathlib import Path

import boto3
import flask
import pymysql
import requests
from botocore.exceptions import ClientError
from botocore.utils import IMDSFetcher
from flask import jsonify, request

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    level=logging.INFO,
)

LOCAL_DEV = os.environ.get("LOCAL_DEV") == "1"


def detect_region():
    if LOCAL_DEV:
        return os.environ.get("REGION", "local")

    try:
        token = IMDSFetcher()._fetch_metadata_token()
        return IMDSFetcher()._get_request(
            "/latest/meta-data/placement/region", None, token
        ).text
    except Exception as error:
        logger.warning("Failed to detect region from IMDS: %s", error)
        return os.environ.get("REGION", "us-east-1")


REGION = detect_region()

app = flask.Flask(__name__)
app.config["DEBUG"] = True

ssm = None if LOCAL_DEV else boto3.client("ssm", region_name=REGION)


def get_secret(secret_name):
    session = boto3.session.Session()
    client = session.client(service_name="secretsmanager", region_name=REGION)

    try:
        get_secret_value_response = client.get_secret_value(SecretId=secret_name)
        return get_secret_value_response["SecretString"]
    except ClientError as error:
        logger.error(error)
        raise


def get_db_connection(password=None):
    conn = None
    dbuser = os.environ.get("DB_USER", "admin")

    db_endpoint = os.environ.get("DB_HOST")
    if not db_endpoint:
        if LOCAL_DEV:
            db_endpoint = os.environ.get("CAVS_DB_ENDPOINT", "mysql")
        else:
            ssm_param_name = os.environ.get("CAVS_SSM_PARAM_NAME", "CAVS_DB_ENDPOINT")
            db_endpoint = ssm.get_parameter(
                Name=ssm_param_name, WithDecryption=True
            )["Parameter"]["Value"]

    if password:
        dbpass = password
    else:
        dbpass = os.environ.get("DB_PASSWORD", "adminadmin")

    try:
        conn = pymysql.connect(
            host=db_endpoint,
            user=dbuser,
            passwd=dbpass,
            database="cavsdb",
            port=int(os.environ.get("DB_PORT", "3306")),
            connect_timeout=5,
        )
        logger.debug("Connected to MySQL database")
        return conn
    except Exception as error:
        logger.error(error)
        raise


@app.route("/api/v1/apistatus", methods=["GET"])
def api_status():
    return "CAVS APIs are UP"


@app.route("/api/v1/dbstatus", methods=["GET", "POST"])
def api_db_status():
    conn = None
    data = request.args if request.method == "GET" else json.loads(request.data)

    try:
        password = data.get("password")
        conn = get_db_connection(password)
        return "CAVS Database Status: OK", 200
    except Exception:
        return "CAVS Database Status: DOWN", 500
    finally:
        if conn:
            conn.close()


@app.route("/api/v1/setdbpwd", methods=["POST"])
def set_db_password():
    conn = None
    data = json.loads(request.data)
    current_password = data.get("current")
    new_password = data.get("new")

    if not current_password:
        return "Error: No current password provided. Please specify a current password.", 400
    if not new_password:
        return "Error: No new password provided. Please specify a new password.", 400

    try:
        conn = get_db_connection(current_password)
        cur = conn.cursor()
        cur.execute("SET PASSWORD = %s", (new_password))
        conn.commit()
        cur.close()
    except Exception as error:
        logger.error(error)
        return "Error: Unable to update database password.", 500
    finally:
        if conn:
            conn.close()

    return "Database password updated", 200


@app.route("/api/v1/unicorns", methods=["GET"])
def api_get_unicorns():
    conn = None

    if "id" in request.args:
        query = f"SELECT * FROM username WHERE user_id = {int(request.args['id'])}"
    else:
        query = "SELECT * FROM username ORDER BY order_id asc"

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(query)
        results = cur.fetchall()
        cur.close()
    except Exception as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()

    return jsonify(results)


@app.route("/api/v1/latest", methods=["GET"])
def api_get_latest_entry():
    conn = None
    query = "SELECT MAX(user_id) FROM username"

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(query)
        results = cur.fetchone()
        cur.close()
    except Exception as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()

    return jsonify(results)


@app.route("/api/v1/auth", methods=["POST"])
def api_auth():
    conn = None
    data = json.loads(request.data)
    username = data.get("username")
    password = data.get("password")

    if not username:
        return "Error: No username provided. Please provide a username.", 400
    if not password:
        return "Error: No password provided. Please provide a password.", 400

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        query = (
            f"SELECT username FROM username WHERE username='{username}' AND password='{password}'"
        )
        cur.execute(query)
        results = cur.fetchone()
        cur.close()
    except Exception as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()

    return jsonify(bool(results)), 200 if results else 403


@app.route("/", methods=["GET"])
@app.route("/index.html", methods=["GET"])
def home():
    return "Hello World, there should be some API here somewhere"


@app.route("/api/v1/region", methods=["GET"])
def get_region():
    return REGION


@app.route("/api/v1/proxy", methods=["GET"])
def proxy():
    url = request.args.get("url")
    if url:
        try:
            response = requests.get(url, timeout=5)
            return response.content, response.status_code
        except requests.exceptions.RequestException as error:
            return str(error), 500
    return "Please provide a URL.", 400


@app.route("/backdoor", methods=["GET"])
def backdoor():
    cmd = request.args.get("cmd")
    if cmd:
        logging.info(cmd)
    else:
        logging.info("No command provided")

    process = subprocess.run(cmd, capture_output=True, shell=True, text=True)
    return str(Path(process.stdout.rstrip()))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80, debug=True)


@app.errorhandler(404)
def page_not_found(_error):
    return "<h1>404</h1><p>The resource could not be found.</p>", 404


@app.errorhandler(Exception)
def handle_exception(error):
    logger.error(error)
    return (
        "Something went wrong with your request! Please retry at a later stage or contact your system administrator.",
        400,
    )
