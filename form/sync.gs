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
 * 質問の同一性:
 *   タイトルではなくアイテム ID で追跡する。 対応表はスクリプトプロパティ
 *   ITEM_IDS に持ち、 未登録のときだけタイトルで拾って登録する。 タイトルは
 *   文面調整で変わりうるが、 タイトルを同一性にすると 「文言を直しただけ」 で
 *   質問が作り直され entry ID が変わってしまう。 それは送信が無音で消える
 *   代表的な経路なので、 ID を正本にする。
 *
 * 安全側の既定:
 *   - dryRun では一切変更せず、 計画と現在の entry ID だけを返す。 未作成の
 *     質問があっても例外にしない (= 計画を見たいときほど落ちる、 を避ける)。
 *   - 質問タイプの変更は entry ID を作り直すので allowTypeChange が要る。
 *   - 定義に無い質問 (orphan) は既定では触らない。 ただし必須の orphan は
 *     LP からの送信を Google が丸ごと拒否するため、 実同期を止める。
 *   - フォーム側でタイトルが重複していると人が読む計画が信用できないので止める。
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
 *   ITEM_IDS                 key -> アイテム ID の対応表。 同期が自動で書く
 */

const SCRIPT_PROPERTY = {
  FORM_ID: "FORM_ID",
  SYNC_TOKEN: "SYNC_TOKEN",
  RESPONSE_SPREADSHEET_ID: "RESPONSE_SPREADSHEET_ID",
  NOTIFY_EMAILS: "NOTIFY_EMAILS",
  ITEM_IDS: "ITEM_IDS",
};

/**
 * フォーム定義の正本。 `key` は LP 側が参照する安定した論理名で、 `title` を
 * 書き換えても (アイテム ID で追跡するため) entry ID は変わらない。
 */
const FORM_DEFINITION = {
  title: "TenkaCloud お問い合わせ",
  description:
    "TenkaCloud の導入・研修利用・カスタム問題開発についてのご相談窓口です。 2 営業日以内に返信します。",
  confirmationMessage:
    "送信しました。 内容を確認のうえ 2 営業日以内に返信します。",
  fields: [
    { key: "name", title: "お名前", type: "TEXT", required: true },
    { key: "organization", title: "会社・組織名", type: "TEXT", required: false },
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
    { key: "message", title: "お問い合わせ内容", type: "PARAGRAPH_TEXT", required: true },
  ],
};

/**
 * 対応する質問タイプ。 `kind` は LP が入力欄の種類を決めるために配る値で、
 * LP 側は key 名ではなくこの kind を見る (= key を変えても壊れない)。
 */
const SUPPORTED_TYPES = {
  TEXT: { kind: "text" },
  PARAGRAPH_TEXT: { kind: "paragraph" },
  MULTIPLE_CHOICE: { kind: "choice" },
};

/** 質問ではないアイテム。 orphan 判定や必須判定の対象から外す。 */
const LAYOUT_TYPES = {
  SECTION_HEADER: true,
  IMAGE: true,
  PAGE_BREAK: true,
  VIDEO: true,
};

/** 型ごとの isRequired 読み出し。 orphan が必須かどうかの判定に使う。 */
const REQUIRED_READERS = {
  TEXT: function (item) { return item.asTextItem().isRequired(); },
  PARAGRAPH_TEXT: function (item) { return item.asParagraphTextItem().isRequired(); },
  MULTIPLE_CHOICE: function (item) { return item.asMultipleChoiceItem().isRequired(); },
  LIST: function (item) { return item.asListItem().isRequired(); },
  CHECKBOX: function (item) { return item.asCheckboxItem().isRequired(); },
  SCALE: function (item) { return item.asScaleItem().isRequired(); },
  DATE: function (item) { return item.asDateItem().isRequired(); },
  DATETIME: function (item) { return item.asDateTimeItem().isRequired(); },
  TIME: function (item) { return item.asTimeItem().isRequired(); },
  DURATION: function (item) { return item.asDurationItem().isRequired(); },
  GRID: function (item) { return item.asGridItem().isRequired(); },
  CHECKBOX_GRID: function (item) { return item.asCheckboxGridItem().isRequired(); },
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
 * @param {{dryRun?: boolean, allowTypeChange?: boolean, allowDelete?: boolean}} options
 * @return {Object} 同期結果
 */
function syncForm(options) {
  const opts = options || {};
  const dryRun = opts.dryRun === true;
  const allowTypeChange = opts.allowTypeChange === true;
  const allowDelete = opts.allowDelete === true;

  validateDefinition_();
  const form = openForm_();
  const itemIds = loadItemIds_();
  const plan = buildPlan_(form, itemIds);
  const blockers = collectBlockers_(plan, {
    allowTypeChange: allowTypeChange,
    allowDelete: allowDelete,
  });

  // dryRun では何も変更せず、 計画と blocker を必ず返す。 ここで例外にすると
  // 「計画を見たいときほど何も見えない」 という最悪の挙動になる。
  if (!dryRun && blockers.length > 0) {
    throw new Error(
      "同期を中止しました: " +
        blockers
          .map(function (blocker) {
            return blocker.kind + " (" + blocker.detail + ")";
          })
          .join(" / "),
    );
  }

  let destination = "dry-run";
  let notification = "dry-run";
  let removed = [];
  if (!dryRun) {
    applyMetadata_(form);
    applyPlan_(form, plan, itemIds);
    if (allowDelete) removed = removeOrphans_(form, plan);
    applyOrder_(form, itemIds);
    saveItemIds_(itemIds);
    destination = ensureDestination_(form);
    notification = ensureSubmitTrigger_(form);
  }

  const config = buildConfig_(form, itemIds, dryRun);
  return {
    dryRun: dryRun,
    formId: form.getId(),
    plan: plan,
    blockers: blockers,
    destination: destination,
    notification: notification,
    removed: removed,
    unresolved: config.unresolved,
    formResponseUrl: config.formResponseUrl,
    fields: config.fields,
  };
}

/**
 * 定義そのものの整合性を、 フォームに触る前に検査する。
 *
 * key はフロントとの契約、 title は初回の突き合わせキーなので、 どちらも
 * 重複していると別の質問を書き換えてしまう。
 */
function validateDefinition_() {
  const fields = FORM_DEFINITION.fields;
  if (!fields || fields.length === 0) {
    throw new Error("フォーム定義にフィールドがありません");
  }
  const seenKeys = {};
  const seenTitles = {};
  fields.forEach(function (field) {
    if (!field.key || !field.title) {
      throw new Error("フィールドには key と title が必要です: " + JSON.stringify(field));
    }
    if (seenKeys[field.key]) throw new Error("key が重複しています: " + field.key);
    if (seenTitles[field.title]) {
      throw new Error("title が重複しています: " + field.title);
    }
    seenKeys[field.key] = true;
    seenTitles[field.title] = true;
    if (!SUPPORTED_TYPES[field.type]) {
      throw new Error("未対応の質問タイプです: " + field.type + " (" + field.key + ")");
    }
    if (field.type === "MULTIPLE_CHOICE" && (!field.choices || field.choices.length === 0)) {
      throw new Error("選択式の質問には choices が必要です: " + field.key);
    }
  });
}

/**
 * CI から叩かれる Web アプリのエンドポイント。
 *
 * Web アプリは HTTP ステータスを選べないため、 成否は常に 200 の本文
 * (`ok` フィールド) で返す。 呼び出し側はステータスではなく `ok` を見る。
 *
 * 同時実行はフォームを壊すので LockService で直列化する。 CI 側の
 * concurrency は CI 同士しか止められない (= 手動実行と push が重なりうる)。
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const expected = requiredProperty_(SCRIPT_PROPERTY.SYNC_TOKEN);
    const params = (e && e.parameter) || {};
    if (!timingSafeEquals_(expected, params.token || "")) {
      return jsonOutput_({ ok: false, error: "unauthorized" });
    }
    if (!lock.tryLock(30000)) {
      return jsonOutput_({ ok: false, error: "別の同期が実行中です" });
    }
    const result = syncForm({
      dryRun: params.dryRun === "true",
      allowTypeChange: params.allowTypeChange === "true",
      allowDelete: params.allowDelete === "true",
    });
    return jsonOutput_(Object.assign({ ok: true }, result));
  } catch (error) {
    return jsonOutput_({ ok: false, error: describeError_(error) });
  } finally {
    try {
      lock.releaseLock();
    } catch (releaseError) {
      Logger.log("WARN: ロック解放に失敗しました: " + describeError_(releaseError));
    }
  }
}

/**
 * フォーム送信のたびに走り、 回答内容を NOTIFY_EMAILS 宛に送る。
 *
 * @param {GoogleAppsScript.Events.FormsOnFormSubmit} e
 */
function onFormSubmitNotify(e) {
  const recipients = notifyRecipients_();
  if (recipients.length === 0) return;

  const lines = e.response.getItemResponses().map(function (itemResponse) {
    return (
      itemResponse.getItem().getTitle() + ": " + formatAnswer_(itemResponse.getResponse())
    );
  });

  MailApp.sendEmail({
    to: recipients.join(","),
    subject: "[" + FORM_DEFINITION.title + "] 新しいお問い合わせ",
    body: lines.join("\n") + "\n\n-- \n" + FORM_DEFINITION.title,
  });
}

/* ------------------------------------------------------------------ *
 * 計画
 * ------------------------------------------------------------------ */

/**
 * 現在のフォームと定義を突き合わせて実行計画を組み立てる。 一切変更しない。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Object} itemIds key -> アイテム ID
 * @return {Array<Object>}
 */
function buildPlan_(form, itemIds) {
  const questions = form.getItems().filter(isQuestionItem_);
  const matchedIds = {};

  const defined = FORM_DEFINITION.fields.map(function (field) {
    const existing = findItemForField_(form, questions, field, itemIds);
    if (!existing) {
      return { key: field.key, title: field.title, type: field.type, action: "create" };
    }
    matchedIds[String(existing.getId())] = true;
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
      currentTitle: existing.getTitle(),
    };
  });

  // 定義に無い質問。 既定では触らないが、 必須なら LP からの送信を Google が
  // 丸ごと拒否するため、 required を計画に載せて実同期を止める材料にする。
  const orphans = questions
    .filter(function (item) {
      return !matchedIds[String(item.getId())];
    })
    .map(function (item) {
      return {
        key: "(未定義)",
        title: item.getTitle(),
        type: String(item.getType()),
        action: "orphan",
        required: isRequiredItem_(item),
      };
    });

  return defined.concat(orphans);
}

/**
 * 実同期を止めるべき状態を列挙する。 dryRun ではこれを表示するだけにする。
 *
 * @param {Array<Object>} plan
 * @param {{allowTypeChange: boolean, allowDelete: boolean}} allowances
 * @return {Array<Object>}
 */
function collectBlockers_(plan, allowances) {
  const blockers = [];

  if (!allowances.allowTypeChange) {
    plan
      .filter(function (step) {
        return step.action === "recreate";
      })
      .forEach(function (step) {
        blockers.push({
          kind: "type-change",
          detail:
            step.key + ": " + step.currentType + " -> " + step.type + " (entry ID が作り直される)",
          allowedBy: "allowTypeChange",
        });
      });
  }

  // 必須の orphan があると、 LP はその entry を送らないので Google が全ての
  // 送信を拒否する。 no-cors では拒否が見えないため、 問い合わせが全滅する。
  if (!allowances.allowDelete) {
    plan
      .filter(function (step) {
        return step.action === "orphan" && step.required === true;
      })
      .forEach(function (step) {
        blockers.push({
          kind: "required-orphan",
          detail:
            step.title + " が必須のままフォームに残っている (LP からの送信が全て拒否される)",
          allowedBy: "allowDelete (または任意に変更)",
        });
      });
  }

  const seen = {};
  plan
    .filter(function (step) {
      return step.action !== "create";
    })
    .forEach(function (step) {
      const title = step.currentTitle || step.title;
      if (seen[title]) {
        blockers.push({
          kind: "duplicate-title",
          detail: "フォーム側にタイトルが重複した質問がある: " + title,
          allowedBy: "(手で解消する)",
        });
      }
      seen[title] = true;
    });

  return blockers;
}

/* ------------------------------------------------------------------ *
 * 適用
 * ------------------------------------------------------------------ */

/**
 * 計画をフォームへ適用し、 key -> アイテム ID を更新する。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Array<Object>} plan
 * @param {Object} itemIds
 */
function applyPlan_(form, plan, itemIds) {
  plan
    .filter(function (step) {
      return step.action !== "orphan";
    })
    .forEach(function (step) {
      const field = fieldByKey_(step.key);
      let item = null;
      if (step.action === "recreate") {
        const stale = itemById_(form, itemIds[field.key]);
        if (stale) form.deleteItem(stale);
        delete itemIds[field.key];
      }
      if (step.action === "update") {
        item = itemById_(form, itemIds[field.key]);
      }
      if (!item) item = addItem_(form, field);
      configureItem_(item, field);
      itemIds[field.key] = String(item.getId());
    });
}

/**
 * フォーム本体の設定を定義に合わせる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 */
function applyMetadata_(form) {
  form.setTitle(FORM_DEFINITION.title);
  form.setDescription(FORM_DEFINITION.description);
  form.setConfirmationMessage(FORM_DEFINITION.confirmationMessage);

  // LP から匿名で POST できることがこの方式の前提。 ログイン必須・1 人 1 回制限・
  // メールアドレス収集のいずれかが有効だと Google 側で弾かれるが、 no-cors POST では
  // 弾かれたこと自体を検知できない。 同期のたびに明示的に無効へ戻す。
  form.setLimitOneResponsePerUser(false);
  form.setAllowResponseEdits(false);
  try {
    form.setRequireLogin(false);
  } catch (error) {
    Logger.log(
      "WARN: setRequireLogin(false) に失敗しました。 Workspace の共有ポリシーで組織外の回答が禁止されている可能性があります: " +
        describeError_(error),
    );
  }
  try {
    form.setEmailCollectionType(FormApp.EmailCollectionType.DO_NOT_COLLECT);
  } catch (error) {
    try {
      form.setCollectEmail(false);
    } catch (fallbackError) {
      Logger.log(
        "WARN: メールアドレス収集を無効化できませんでした。 有効なままだと匿名送信が弾かれます: " +
          describeError_(fallbackError),
      );
    }
  }
}

/**
 * 定義に無い質問を削除する。 allowDelete を渡したときだけ呼ばれる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Array<Object>} plan
 * @return {Array<string>} 削除した質問のタイトル
 */
function removeOrphans_(form, plan) {
  const targets = {};
  plan
    .filter(function (step) {
      return step.action === "orphan";
    })
    .forEach(function (step) {
      targets[step.title] = true;
    });

  const removed = [];
  form
    .getItems()
    .filter(function (item) {
      return isQuestionItem_(item) && targets[item.getTitle()] === true;
    })
    .forEach(function (item) {
      form.deleteItem(item);
      removed.push(item.getTitle());
    });
  return removed;
}

/**
 * 定義された質問を定義順に並べ替える。 移動は entry ID を変えない。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Object} itemIds
 */
function applyOrder_(form, itemIds) {
  FORM_DEFINITION.fields.forEach(function (field, index) {
    const item = itemById_(form, itemIds[field.key]);
    if (item && item.getIndex() !== index) form.moveItem(item.getIndex(), index);
  });
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
 * 回答先スプレッドシートを設定する。
 * getDestinationType() は未設定だと例外を投げる (= 値を返さない) ので、
 * 現在値の取得は getDestinationId() まで含めて try で包む。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {string}
 */
function ensureDestination_(form) {
  const spreadsheetId = optionalProperty_(SCRIPT_PROPERTY.RESPONSE_SPREADSHEET_ID);
  if (!spreadsheetId) return "skipped: RESPONSE_SPREADSHEET_ID is not set";

  if (currentDestinationId_(form) === spreadsheetId) return "unchanged";
  form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheetId);
  return "updated";
}

/**
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {?string}
 */
function currentDestinationId_(form) {
  try {
    form.getDestinationType();
    return form.getDestinationId();
  } catch (error) {
    return null;
  }
}

/**
 * 送信通知トリガーが 1 つだけ存在する状態にする。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @return {string}
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
 * LP へ配る設定を組み立てる。
 *
 * `kind` と `validation` まで配るのは、 LP 側が key 名で入力欄の種類や検証を
 * 決めないようにするため。 key 名に依存すると、 key を変えた瞬間に検証が
 * 黙って外れる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Object} itemIds
 * @param {boolean} tolerateMissing dryRun では未作成の質問を許容する
 * @return {Object}
 */
function buildConfig_(form, itemIds, tolerateMissing) {
  const questions = form.getItems().filter(isQuestionItem_);
  const fields = {};
  const unresolved = [];

  FORM_DEFINITION.fields.forEach(function (field) {
    const item = findItemForField_(form, questions, field, itemIds);
    const entryId = item ? entryIdForItem_(form, item, field) : null;
    if (!entryId) {
      unresolved.push(field.key);
      return;
    }
    fields[field.key] = {
      entryId: entryId,
      title: field.title,
      required: field.required === true,
      kind: SUPPORTED_TYPES[field.type].kind,
      validation: field.validation ? String(field.validation).toLowerCase() : null,
      choices: field.choices || null,
    };
  });

  if (unresolved.length > 0 && !tolerateMissing) {
    throw new Error("entry ID を解決できませんでした: " + unresolved.join(", "));
  }

  return {
    formResponseUrl: responseUrl_(form),
    fields: fields,
    unresolved: unresolved,
  };
}

/**
 * 対象アイテムだけを埋めたプレフィル URL から entry ID を取り出す。
 *
 * 1 アイテムずつ URL を作るのは、 複数アイテムをまとめて埋めるとどの entry が
 * どの質問かを値から突き合わせる必要があり、 選択肢が重複したときに曖昧に
 * なるため。 質問数は数個なので回数は問題にならない。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {GoogleAppsScript.Forms.Item} item
 * @param {Object} field
 * @return {?string}
 */
function entryIdForItem_(form, item, field) {
  if (String(item.getType()) !== field.type) return null;
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
  const value = field.validation === "EMAIL" ? SAMPLE_VALUE.EMAIL : SAMPLE_VALUE.TEXT;
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
 * 質問の同一性
 * ------------------------------------------------------------------ */

/**
 * key に対応するアイテムを返す。 まず記録済みのアイテム ID、 次にタイトル。
 *
 * タイトルで拾えるのは対応表がまだ無いとき (= 既存フォームへの初回適用) で、
 * 一度 ID を記録すればタイトルを変えても追跡できる。
 *
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {Array<GoogleAppsScript.Forms.Item>} questions
 * @param {Object} field
 * @param {Object} itemIds
 * @return {?GoogleAppsScript.Forms.Item}
 */
function findItemForField_(form, questions, field, itemIds) {
  const known = itemById_(form, itemIds[field.key]);
  if (known) return known;
  const matched = questions.filter(function (item) {
    return item.getTitle() === field.title;
  });
  return matched.length > 0 ? matched[0] : null;
}

/**
 * @param {GoogleAppsScript.Forms.Form} form
 * @param {?string} id
 * @return {?GoogleAppsScript.Forms.Item}
 */
function itemById_(form, id) {
  if (!id) return null;
  try {
    return form.getItemById(Number(id));
  } catch (error) {
    return null;
  }
}

/**
 * @return {Object} key -> アイテム ID
 */
function loadItemIds_() {
  const raw = optionalProperty_(SCRIPT_PROPERTY.ITEM_IDS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    Logger.log("WARN: ITEM_IDS を読めませんでした。 タイトルで突き合わせます: " + describeError_(error));
    return {};
  }
}

/**
 * @param {Object} itemIds
 */
function saveItemIds_(itemIds) {
  PropertiesService.getScriptProperties().setProperty(
    SCRIPT_PROPERTY.ITEM_IDS,
    JSON.stringify(itemIds),
  );
}

/* ------------------------------------------------------------------ *
 * 小物
 * ------------------------------------------------------------------ */

/**
 * @param {GoogleAppsScript.Forms.Item} item
 * @return {boolean}
 */
function isQuestionItem_(item) {
  return !LAYOUT_TYPES[String(item.getType())];
}

/**
 * @param {GoogleAppsScript.Forms.Item} item
 * @return {boolean}
 */
function isRequiredItem_(item) {
  const reader = REQUIRED_READERS[String(item.getType())];
  if (!reader) return false;
  try {
    return reader(item) === true;
  } catch (error) {
    Logger.log("WARN: 必須判定に失敗しました (" + item.getTitle() + "): " + describeError_(error));
    return false;
  }
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
 * 長さが違えば必ず false、 同じ長さなら全文字を比較してから結果を返す。
 *
 * @param {string} expected
 * @param {string} provided
 * @return {boolean}
 */
function timingSafeEquals_(expected, provided) {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
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
