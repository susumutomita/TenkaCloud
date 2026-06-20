# Raycast Community Japan Collaboration Plan

This plan prepares the first TenkaCloud conversation with Raycast Community Japan, AI developer communities, and security event communities. The goal is to make the first proposal concrete enough to discuss while keeping preparation, safety, and scope small.

## Recommended First Collaboration

Start with a 1-hour mini GameDay plus a small Raycast operator console demo.

This format is the best first proposal because it is concrete, low-risk, and easy to explain. Participants experience a small broken cloud scenario, while the organizer shows how Raycast could become a fast command surface for checking teams, scores, hints, and incident status.

## Collaboration Ideas

| Idea | Audience fit | Preparation | Safety concerns | Demo value | Raycast relevance | TenkaCloud learning value | 1-2 hour fit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1-hour mini GameDay | Strong fit for AI developers, cloud learners, SREs, and security study groups. | Prepare one small problem, team accounts, opening instructions, and wrap-up notes. | Keep environments isolated, avoid real credentials, and predefine teardown. | High; participants fix a visible failure under time pressure. | Medium; Raycast can support operator monitoring and status checks. | High; validates the event flow, scoring, hints, and operator needs. | Strong. |
| Raycast-powered operator console demo | Strong fit for Raycast users and event organizers. | Prepare a scripted demo using read-only commands from the Raycast extension concept. | Low if commands stay read-only and use demo data. | High; makes the collaboration angle immediately visible. | Very high; Raycast is the main interaction surface. | Medium; validates which operator commands matter first. | Strong as a 10-15 minute segment. |
| AI agent operations challenge | Strong fit for AI agent builders and cloud automation communities. | Prepare agent instructions, scoring rules, guardrails, and repeatable tasks. | Medium; agents need strict boundaries and no access to secrets or shared systems. | High; shows AI acting in realistic operations workflows. | Medium; Raycast can be an operator surface rather than the participant tool. | High; explores future AI-era positioning. | Medium; likely better as a second event. |
| Security study group with real broken cloud | Strong fit for security and cloud communities that want hands-on practice. | Prepare one intentionally vulnerable or misconfigured environment and facilitator notes. | Medium; scope must avoid offensive actions outside the sandbox. | Medium to high; participants learn by fixing real symptoms. | Low to medium; Raycast can help organizers but is not central. | High; tests problem authoring and learner comprehension. | Strong. |
| Attack/defense visualization event | Strong fit for meetup audiences and demo booths. | Prepare live dashboard views, event data, visual cues, and a stable script. | Medium; avoid implying live attacks against real external systems. | Very high; it is visually memorable. | Medium; Raycast can trigger views or operator actions. | Medium; more about storytelling than core workflow validation. | Medium; best after the first mini GameDay proves the scenario. |

## First Event Shape

| Segment | Time | Content |
| --- | --- | --- |
| Opening | 5 minutes | Explain TenkaCloud, the exercise goal, safety boundaries, and the success condition. |
| Hands-on mini GameDay | 35 minutes | Participants diagnose and recover from one small cloud or security issue. |
| Raycast operator demo | 10 minutes | Show the operator checking event status, teams, scoreboard, recent audit logs, and the event dashboard from Raycast. |
| Debrief | 10 minutes | Discuss what participants noticed, what Raycast could make faster, and what would be useful in a second event. |

## Required Assets

- One short TenkaCloud pitch for the opening.
- One small, safe exercise scenario with a clear success condition.
- Team login or demo participant access instructions.
- Application admin console demo tenant and event.
- Raycast operator concept demo script, preferably read-only.
- Scoreboard or event-status view prepared before the event.
- Facilitator runbook with setup, recovery hints, and teardown steps.
- Post-event feedback questions for participants and organizers.

## Safety Boundaries

- Use isolated demo environments only.
- Do not use production AWS accounts, real customer data, or reusable secrets.
- Keep the first Raycast demo read-only.
- Do not expose AWS credentials, ExternalIds, team login keys, or admin tokens in slides, screenshots, or Raycast preferences.
- Avoid offensive actions against external targets; every scenario should stay inside the prepared sandbox.
- Predefine teardown and verify that event resources can be cleaned up.
- Use explicit confirmation for any later destructive operator action such as deploy, disruption fire, event end, or scoring lock.

## Event Title Candidates

- Raycast x TenkaCloud Mini GameDay: Operate a Broken Cloud
- 1-Hour Cloud Rescue GameDay with Raycast
- AI-Era Cloud Operations Drill with TenkaCloud
- Real Broken Cloud Study Group: Diagnose, Recover, Debrief
- Raycast Operator Console Demo for Cloud GameDays

## Discussion Questions

- Which audience should the first event target: Raycast users, AI developers, cloud learners, or security study group members?
- Should the first Raycast segment be a concept demo, a mock extension, or a small working read-only extension?
- Which exercise type is safest and easiest to explain in one hour?
- What would make the event valuable enough for participants to recommend to others?
- What follow-up format would Raycast Community Japan want if the first event works?

## Message Draft for Yano-san

```text
矢野さん

先日は Raycast Community Japan や AI / Developer Community のお話をありがとうございます。
TenkaCloud 側で、最初に軽く試せる共同企画案を整理しました。

一番よさそうだと思っているのは、
「1 時間のミニ GameDay + Raycast 運営コマンドの小さなデモ」です。

参加者は小さな壊れたクラウド環境を診断・復旧し、
主催者側は Raycast からイベント状況、チーム状態、スコア、監査ログなどを確認する、
という形です。

重い実装や大規模イベントに入る前に、
Raycast ユーザー / AI 開発者 / クラウド・セキュリティ学習者のどこに一番刺さるかを
一緒に観察できる小さな回にしたいです。

候補としては以下も考えています。

- Raycast-powered operator console demo
- AI agent operations challenge
- Security study group with real broken cloud
- Attack/defense visualization event

まずは 30 分ほど、どの形式がコミュニティに合いそうか相談させていただけますか？
```

## Follow-Up After Agreement

If the first proposal is accepted, create implementation issues for the event scenario, Raycast demo script, facilitator runbook, and participant feedback form.
