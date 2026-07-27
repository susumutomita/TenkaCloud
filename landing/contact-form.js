/**
 * お問い合わせフォームの純ロジック (DOM に触らない)。
 *
 * LP は Google フォームの formResponse エンドポイントへ直接 POST する。
 * その POST に必要な `entry.<数字>` は Google が採番するため、
 * form/sync.gs が同期のたびに逆引きして landing/contact-form-config.json を
 * 再生成し、 このモジュールが実行時に読み込む。
 *
 * ここを DOM から切り離しているのは、 設定の検証と payload 組み立てという
 * 「壊れると送信が無音で消える」部分をテストで固定するため。 DOM 配線と
 * 多言語化は landing/app.js が持つ。
 *
 * 入力欄の種類や検証は設定の `kind` / `validation` から決める。 key 名で
 * 分岐すると、 key を変えた瞬間に検証が黙って外れる。
 *
 * 送信は no-cors POST なので応答を読めない (= 失敗を検知できない)。 だからこそ
 * 設定不備は送信前に例外で落とし、 フォームを出さずに従来の Google フォーム
 * リンクを残す。 黙って壊れたフォームを見せない。
 */
((global, factory) => {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    global.TenkaContactForm = factory();
  }
})(globalThis, () => {
  var ENTRY_ID_PATTERN = /^entry\.\d+$/;
  var RESPONSE_URL_PATTERN = /^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/formResponse$/;
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var KINDS = { text: true, paragraph: true, choice: true };

  /**
   * 設定 JSON を検証して返す。 形が想定と違えば例外にする。
   *
   * @param {unknown} raw fetch した JSON
   * @return {{formResponseUrl: string, fields: Object}}
   */
  function parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("contact form config is not an object");
    }
    if (!RESPONSE_URL_PATTERN.test(String(raw.formResponseUrl))) {
      throw new Error(
        `contact form config has an unexpected formResponseUrl: ${String(raw.formResponseUrl)}`,
      );
    }
    if (!raw.fields || typeof raw.fields !== "object") {
      throw new Error("contact form config has no fields");
    }
    var keys = Object.keys(raw.fields);
    if (keys.length === 0) {
      throw new Error("contact form config has no fields");
    }
    keys.forEach((key) => {
      var field = raw.fields[key];
      if (!field || !ENTRY_ID_PATTERN.test(String(field.entryId))) {
        throw new Error(
          `contact form config has an invalid entry id for ${key}: ${String(field?.entryId)}`,
        );
      }
      if (!KINDS[String(field.kind)]) {
        throw new Error(
          `contact form config has an unknown kind for ${key}: ${String(field.kind)}`,
        );
      }
      if (
        field.kind === "choice" &&
        (!Array.isArray(field.choices) || field.choices.length === 0)
      ) {
        throw new Error(`contact form config has no choices for ${key}`);
      }
    });
    return { formResponseUrl: raw.formResponseUrl, fields: raw.fields };
  }

  /**
   * 入力値を検証し、 問題のあるフィールドを返す。
   *
   * no-cors POST では Google 側の必須チェックに落ちても検知できないため、
   * 必須・形式の検証は送信前にこちらで済ませる。
   *
   * @param {{fields: Object}} config
   * @param {Object} values キーはフィールド key
   * @return {Array<{key: string, reason: string}>}
   */
  function validate(config, values) {
    var problems = [];
    Object.keys(config.fields).forEach((key) => {
      var field = config.fields[key];
      var value = String(values?.[key] || "").trim();
      if (field.required && value === "") {
        problems.push({ key: key, reason: "required" });
        return;
      }
      if (field.validation === "email" && value !== "" && !EMAIL_PATTERN.test(value)) {
        problems.push({ key: key, reason: "email" });
      }
    });
    return problems;
  }

  /**
   * 入力値を entry ID 付きの送信ペアへ変換する。
   *
   * 設定に無いキーは黙って捨てず例外にする。 捨てると「LP に項目はあるのに
   * 保存されない」壊れ方になり、 no-cors では誰も気づけない。 必須項目が空の
   * まま来た場合も同じ理由で例外にする (= 呼び出し側が検証を飛ばしても、
   * Google に黙って捨てられる送信を作らない)。
   *
   * @param {{fields: Object}} config
   * @param {Object} values
   * @return {Array<[string, string]>}
   */
  function buildPayload(config, values) {
    var provided = Object.keys(values || {});
    var unknown = provided.filter((key) => !config.fields[key]);
    if (unknown.length > 0) {
      throw new Error(`contact form config has no entry id for: ${unknown.join(", ")}`);
    }
    var pairs = provided
      .map((key) => [config.fields[key].entryId, String(values[key]).trim()])
      .filter((pair) => pair[1] !== "");

    var missing = Object.keys(config.fields).filter(
      (key) => config.fields[key].required && String(values?.[key] || "").trim() === "",
    );
    if (missing.length > 0) {
      throw new Error(`contact form is missing required values for: ${missing.join(", ")}`);
    }
    return pairs;
  }

  /**
   * Google フォームへ送信する。
   *
   * mode: "no-cors" なので応答は読めず、 戻り値は「送信を試みた」ことしか
   * 意味しない。 ネットワーク層の失敗だけが reject として観測できる。
   *
   * 本文を URLSearchParams にしているのは、 no-cors が許す Content-Type が
   * 限られており、 その中で境界文字列を持たない最も単純な形だから。 Google
   * フォームは urlencoded の POST をそのまま受け付ける。
   *
   * @param {{formResponseUrl: string, fields: Object}} config
   * @param {Object} values
   * @param {{fetch: Function}} runtime
   * @return {Promise<void>}
   */
  function submit(config, values, runtime) {
    var pairs = buildPayload(config, values);
    var body = new URLSearchParams();
    pairs.forEach((pair) => {
      body.append(pair[0], pair[1]);
    });
    return runtime.fetch(config.formResponseUrl, {
      method: "POST",
      mode: "no-cors",
      body: body,
    });
  }

  return {
    parseConfig: parseConfig,
    validate: validate,
    buildPayload: buildPayload,
    submit: submit,
  };
});
