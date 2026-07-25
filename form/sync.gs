/**
 * TenkaCloud お問い合わせフォームの定義 (Google Apps Script)。
 *
 * ねらい:
 *   LP (= landing/) は自前の HTML フォームから Google フォームの formResponse
 *   エンドポイントへ直接 POST する。 その POST が成立するには質問ごとの
 *   `entry.<数字>` が必要だが、 この ID は Google が採番するため手書きできず、
 *   フォーム側を編集するとズレる。 ズレても no-cors POST では失敗を検知できず、
 *   送信が無音で消える。
 *
 *   そこでフォーム定義自体をこのファイルに集約し、 同期のたびに entry ID を
 *   逆引きして landing/contact-form-config.json を再生成する。 LP は実行時に
 *   その JSON を読むので、 フォーム変更に自動追従する。
 *
 * 冪等性:
 *   syncForm() は既存の質問をタイトルで突き合わせ、 その場で更新する
 *   (= 削除して作り直さない)。 質問タイプを変えない限り entry ID は維持される。
 *   タイプ変更は entry ID を壊すため、 既定では計画段階で失敗させ、
 *   allowTypeChange を明示したときだけ実行する。
 *
 * 実行経路:
 *   .github/workflows/form-sync.yml が clasp push した後、 Web アプリ (doPost)
 *   を SYNC_TOKEN 付きで叩く。 clasp run は GCP プロジェクト関連付けと
 *   API 実行可能デプロイが必要になるため使わない。
 *
 * スクリプトプロパティ (Apps Script エディタの「プロジェクトの設定」で設定):
 *   FORM_ID                  対象フォームの ID (必須)
 *   SYNC_TOKEN               doPost の共有シークレット (必須)
 *   RESPONSE_SPREADSHEET_ID  回答先スプレッドシートの ID (任意)
 *   NOTIFY_EMAILS            送信通知の宛先。 カンマ区切り (任意)
 */

const SCRIPT_PROPERTY = {
  FORM_ID: "FORM_ID",
  SYNC_TOKEN: "SYNC_TOKEN",
  RESPONSE_SPREADSHEET_ID: "RESPONSE_SPREADSHEET_ID",
  NOTIFY_EMAILS: "NOTIFY_EMAILS",
};

/**
 * フォーム定義の正本。 `key` は LP 側が参照する安定した論理名で、 `title` を
 * 日本語で書き換えても LP のコードは壊れない。 entry ID は key に対して配る。
 */
const FORM_DEFINITION = {
  title: "TenkaCloud お問い合わせ",
  description:
    "TenkaCloud の導入・研修利用・カスタム問題開発についてのご相談窓口です。 2 営業日以内に返信します。",
  confirmationMessage:
    "送信しました。 内容を確認のうえ 2 営業日以内に返信します。",
  fields: [
    {
      key: "name",
      title: "お名前",
      type: "TEXT",
      required: true,
    },
    {
      key: "organization",
      title: "会社・組織名",
      type: "TEXT",
      required: false,
    },
    {
      key: "email",
      title: "メールアドレス",
      type: "TEXT",
      required: true,
      validation: "EMAIL",
    },
    {
      key: "topic",
      title: "お問い合わせ種別",
      type: "MULTIPLE_CHOICE",
      required: true,
      choices: [
        "プラン・見積もりの相談",
        "企業内の研修・演習での利用",
        "カスタム問題の追加開発",
        "その他",
      ],
    },
    {
      key: "message",
      title: "お問い合わせ内容",
      type: "PARAGRAPH_TEXT",
      required: true,
    },
  ],
};

/** entry ID を逆引きするときに入れる、 検証を通る当たり障りのないサンプル値。 */
const SAMPLE_VALUE = {
  TEXT: "sample",
  EMAIL: "sample@example.com",
  PARAGRAPH_TEXT: "sample",
};

/* ------------------------------------------------------------------ *
 * エントリポイント
 * ------------------------------------------------------------------ */

/**
 * フォームを定義どおりに同期し、 entry マップを返す。
 *
 * @param {{dryRun?: boolean, allowTypeChange?: boolean}} options
 * @return {Object} 同期結果 (計画 / entry マップ / 回答先 / 通知先)
 */
function syncForm(options) {
  const opts = options || {};
  const dryRun = opts.dryRun === true;
  const allowTypeChange = opts.allowTypeChange === true;

  const form = openForm_();
  const plan = buildPlan_(form);

  const breaking = plan.filter(function (step) {
    return step.action === "recreate";
  });
  if (breaking.length > 0 && !allowTypeChange) {
    throw new Error(
      "質問タイプの変更は entry ID を壊します。 意図した変更なら allowTypeChange を指定してください: " +
        breaking
          .map(function (step) {
            return step.key + " (" + step.currentType + " -> " + step.type + ")";
          })
          .join(", "),
    );
  }

  let destination = "dry-run";
  let notification = "dry-run";
  if (!dryRun) {
    applyMetadata_(form);
    applyPlan_(form, plan);
    destination = ensureDestination_(form);
    notification = ensureSubmitTrigger_(form);
  }

  const config = buildConfig_(form);
  return {
    dryRun: dryRun,
    formId: form.getId(),
    plan: plan,
    destination: destination,
    notification: notification,
    formResponseUrl: config.formResponseUrl,
    fields: config.fields,
  };
}

/**
 * CI から叩かれる Web アプリのエンドポイント。
 *
 * Web アプリは HTTP ステータスを選べないため、 成否は常に 200 の本文
 * (`ok` フィールド) で返す。 呼び出し側はステータスではなく `ok` を見る。
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  try {
    const expected = requiredProperty_(SCRIPT_PROPERTY.SYNC_TOKEN);
    const params = (e && e.parameter) || {};
    if (!timingSafeEquals_(expected, params.token || "")) {
      return jsonOutput_({ ok: false, error: "unauthorized" });
    }
    const result = syncForm({
      dryRun: params.dryRun === "true",
      allowTypeChange: params.allowTypeChange === "true",
    });
    return jsonOutput_(Object.assign({ ok: true }, result));
  } catch (error) {
    return jsonOutput_({ ok: false, error: describeError_(error) });
  }
}

/**
 * フォーム送信のたびに走り、 回答内容を NOTIFY_EMAILS 宛に送る。
 * ScriptApp のインストール型トリガーから呼ばれる。
 *
 * @param {GoogleAppsScript.Events.FormsOnFormSubmit} e
 */
function onFormSubmitNotify(e) {
  const recipients = notifyRecipients_();
  if (recipients.length === 0) return;

  const lines = e.response.getItemResponses().map(function (itemResponse) {
    return (
      itemResponse.getItem().getTitle() +
      ": " +
      formatAnswer_(itemResponse.getResponse())
    );
  });

  MailApp.sendEmail({
    to: recipients.join(","),
    subject: "[" + FORM_DEFINITION.title + "] 新しいお問い合わせ",
    body: lines.join("\n") + "\n\n-- \n" + FORM_DEFINITION.title,
  });
}

/* ------------------------------------------------------------------ *
 * 同期の内訳
 * ------------------------------------------------------------------ */

/**
 * 現在のフォームと定義を突き合わせ、 実行計画を組み立てる。
 * ここでは一切変更しないので、 dry-run でそのまま差分レビューに使える。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {Array<Object>}
 */
function buildPlan_(form) {
  const items = form.getItems();
  return FORM_DEFINITION.fields.map(function (field) {
    const existing = findItemByTitle_(items, field.title);
    if (!existing) {
      return {
        key: field.key,
        title: field.title,
        type: field.type,
        action: "create",
      };
    }
    const currentType = String(existing.getType());
    if (currentType !== field.type) {
      return {
        key: field.key,
        title: field.title,
        type: field.type,
        currentType: currentType,
        action: "recreate",
      };
    }
    return {
      key: field.key,
      title: field.title,
      type: field.type,
      action: "update",
    };
  });
}

/**
 * 計画をフォームへ適用する。 update は既存アイテムをその場で書き換えるため
 * entry ID を保つ。 recreate だけが entry ID を作り直す。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Array<Object>} plan
 */
function applyPlan_(form, plan) {
  plan.forEach(function (step) {
    const field = fieldByKey_(step.key);
    if (step.action === "recreate") {
      const stale = findItemByTitle_(form.getItems(), field.title);
      if (stale) form.deleteItem(stale);
    }
    const item =
      step.action === "update"
        ? findItemByTitle_(form.getItems(), field.title)
        : addItem_(form, field);
    configureItem_(item, field);
  });
}

/**
 * フォーム本体のタイトル・説明・確認メッセージを定義に合わせる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 */
function applyMetadata_(form) {
  form.setTitle(FORM_DEFINITION.title);
  form.setDescription(FORM_DEFINITION.description);
  form.setConfirmationMessage(FORM_DEFINITION.confirmationMessage);
}

/**
 * 定義に沿った空のアイテムを追加する。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Object} field
 * @return {GoogleAppsScript.Forms.Item}
 */
function addItem_(form, field) {
  if (field.type === "PARAGRAPH_TEXT") return form.addParagraphTextItem();
  if (field.type === "MULTIPLE_CHOICE") return form.addMultipleChoiceItem();
  return form.addTextItem();
}

/**
 * タイトル・必須・選択肢・入力検証を定義に合わせる。
 *
 * @param {GoogleAppsScript.Forms.Item} item
 * @param {Object} field
 */
function configureItem_(item, field) {
  item.setTitle(field.title);
  if (field.type === "PARAGRAPH_TEXT") {
    item.asParagraphTextItem().setRequired(field.required === true);
    return;
  }
  if (field.type === "MULTIPLE_CHOICE") {
    const choice = item.asMultipleChoiceItem();
    choice.setChoiceValues(field.choices);
    choice.setRequired(field.required === true);
    return;
  }
  const text = item.asTextItem();
  text.setRequired(field.required === true);
  if (field.validation === "EMAIL") {
    text.setValidation(
      FormApp.createTextValidation()
        .requireTextIsEmail()
        .setHelpText("メールアドレスの形式で入力してください。")
        .build(),
    );
  }
}

/**
 * 回答先スプレッドシートを設定する。 既に同じ宛先ならそのままにする。
 * getDestinationType() は未設定だと例外を投げる (= 値を返さない) ので、
 * 現在値の取得は必ず try で包む。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {string} 実行結果の説明
 */
function ensureDestination_(form) {
  const spreadsheetId = optionalProperty_(
    SCRIPT_PROPERTY.RESPONSE_SPREADSHEET_ID,
  );
  if (!spreadsheetId) return "skipped: RESPONSE_SPREADSHEET_ID is not set";

  if (currentDestinationId_(form) === spreadsheetId) return "unchanged";
  form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheetId);
  return "updated";
}

/**
 * 回答先スプレッドシートの ID。 未設定なら null。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {?string}
 */
function currentDestinationId_(form) {
  try {
    form.getDestinationType();
  } catch (error) {
    return null;
  }
  return form.getDestinationId();
}

/**
 * 送信通知トリガーが 1 つだけ存在する状態にする。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {string} 実行結果の説明
 */
function ensureSubmitTrigger_(form) {
  if (notifyRecipients_().length === 0) {
    return "skipped: NOTIFY_EMAILS is not set";
  }
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return (
      trigger.getHandlerFunction() === "onFormSubmitNotify" &&
      trigger.getTriggerSourceId() === form.getId()
    );
  });
  if (existing.length === 1) return "unchanged";

  existing.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("onFormSubmitNotify").forForm(form).onFormSubmit().create();
  return existing.length === 0 ? "created" : "recreated";
}

/* ------------------------------------------------------------------ *
 * entry ID の逆引き
 * ------------------------------------------------------------------ */

/**
 * LP へ配る設定を組み立てる。 これがそのまま
 * landing/contact-form-config.json になる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {Object}
 */
function buildConfig_(form) {
  const items = form.getItems();
  const fields = {};
  FORM_DEFINITION.fields.forEach(function (field) {
    const item = findItemByTitle_(items, field.title);
    if (!item) return;
    fields[field.key] = {
      entryId: entryIdForItem_(form, item, field),
      title: field.title,
      required: field.required === true,
      choices: field.choices || null,
    };
  });

  const missing = FORM_DEFINITION.fields
    .filter(function (field) {
      return !fields[field.key] || !fields[field.key].entryId;
    })
    .map(function (field) {
      return field.key;
    });
  if (missing.length > 0) {
    throw new Error("entry ID を解決できませんでした: " + missing.join(", "));
  }

  return {
    formResponseUrl: responseUrl_(form),
    fields: fields,
  };
}

/**
 * 対象アイテムだけを埋めたプレフィル URL から entry ID を取り出す。
 *
 * 1 アイテムずつ URL を作るのは、 複数アイテムをまとめて埋めると
 * どの entry がどの質問かを値から突き合わせる必要があり、 選択肢が
 * 重複したときに曖昧になるため。 質問数は数個なので回数は問題にならない。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {GoogleAppsScript.Forms.Item} item
 * @param {Object} field
 * @return {?string}
 */
function entryIdForItem_(form, item, field) {
  const itemResponse = sampleResponse_(item, field);
  if (!itemResponse) return null;
  const url = form.createResponse().withItemResponse(itemResponse).toPrefilledUrl();
  const matched = url.match(/[?&]entry\.(\d+)=/);
  return matched ? "entry." + matched[1] : null;
}

/**
 * entry ID の逆引き専用のサンプル回答。 入力検証を通る値を選ぶ。
 *
 * @param {GoogleAppsScript.Forms.Item} item
 * @param {Object} field
 * @return {?GoogleAppsScript.Forms.ItemResponse}
 */
function sampleResponse_(item, field) {
  if (field.type === "PARAGRAPH_TEXT") {
    return item.asParagraphTextItem().createResponse(SAMPLE_VALUE.PARAGRAPH_TEXT);
  }
  if (field.type === "MULTIPLE_CHOICE") {
    return item.asMultipleChoiceItem().createResponse(field.choices[0]);
  }
  const value =
    field.validation === "EMAIL" ? SAMPLE_VALUE.EMAIL : SAMPLE_VALUE.TEXT;
  return item.asTextItem().createResponse(value);
}

/**
 * 自前フォームの POST 先。 公開 URL の viewform を formResponse に読み替える。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {string}
 */
function responseUrl_(form) {
  return form.getPublishedUrl().replace(/\/viewform.*$/, "/formResponse");
}

/* ------------------------------------------------------------------ *
 * 小物
 * ------------------------------------------------------------------ */

/**
 * @param {Array<GoogleAppsScript.Forms.Item>} items
 * @param {string} title
 * @return {?GoogleAppsScript.Forms.Item}
 */
function findItemByTitle_(items, title) {
  const matched = items.filter(function (item) {
    return item.getTitle() === title;
  });
  return matched.length > 0 ? matched[0] : null;
}

/**
 * @param {string} key
 * @return {Object}
 */
function fieldByKey_(key) {
  const matched = FORM_DEFINITION.fields.filter(function (field) {
    return field.key === key;
  });
  if (matched.length === 0) throw new Error("未知のフィールドです: " + key);
  return matched[0];
}

/**
 * @return {GoogleAppsScript.Forms.Form}
 */
function openForm_() {
  return FormApp.openById(requiredProperty_(SCRIPT_PROPERTY.FORM_ID));
}

/**
 * @param {string} name
 * @return {string}
 */
function requiredProperty_(name) {
  const value = optionalProperty_(name);
  if (!value) throw new Error("スクリプトプロパティが未設定です: " + name);
  return value;
}

/**
 * @param {string} name
 * @return {string}
 */
function optionalProperty_(name) {
  return (PropertiesService.getScriptProperties().getProperty(name) || "").trim();
}

/**
 * @return {Array<string>}
 */
function notifyRecipients_() {
  return optionalProperty_(SCRIPT_PROPERTY.NOTIFY_EMAILS)
    .split(",")
    .map(function (address) {
      return address.trim();
    })
    .filter(function (address) {
      return address.length > 0;
    });
}

/**
 * 長さと内容の差を早期 return で漏らさない比較。 トークン照合に使う。
 *
 * @param {string} expected
 * @param {string} provided
 * @return {boolean}
 */
function timingSafeEquals_(expected, provided) {
  let diff = expected.length ^ provided.length;
  const length = Math.max(expected.length, provided.length);
  for (let index = 0; index < length; index += 1) {
    diff |= expected.charCodeAt(index % expected.length || 0) ^
      provided.charCodeAt(index % (provided.length || 1) || 0);
  }
  return diff === 0 && expected.length === provided.length;
}

/**
 * @param {*} answer
 * @return {string}
 */
function formatAnswer_(answer) {
  return Array.isArray(answer) ? answer.join(", ") : String(answer);
}

/**
 * @param {*} error
 * @return {string}
 */
function describeError_(error) {
  return String((error && error.message) || error);
}

/**
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
