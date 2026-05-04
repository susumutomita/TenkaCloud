/**
 * Microsoft Graph - B2B invitation + appRole assignment。
 *
 * `inviteAndAssignGuestUsers`: per-tenant Enterprise App に対して guest user を
 * `/invitations` で B2B 招待し、招待後に `/servicePrincipals/{sp}/appRoleAssignments`
 * で role を割り当てる。Graph の `/invitations` throttle (~10 req/s/app+tenant) を
 * 避けるために chunk 並列化する。
 */

const { graphRequest } = require("./client");

const INVITE_CONCURRENCY = 5;
const NULL_APP_ROLE_ID = "00000000-0000-0000-0000-000000000000";

function pickAssignableAppRole(appRoles) {
  return (
    appRoles.find((role) => role.value === "msiam_access" || role.displayName === "msiam_access") ||
    appRoles.find((role) => (role.allowedMemberTypes || []).includes("User") && role.isEnabled) || {
      id: NULL_APP_ROLE_ID,
    }
  );
}

/**
 * service が「招待を実行せずに role の id だけ知りたい」(JIT 用に Lambda env に
 * 焼き込みたい等) ケース用 public API。internal helper の `pickAssignableAppRole`
 * を service が直接掴まないようにするための薄いラッパ。
 */
function resolveAppRole(enterpriseApp) {
  return pickAssignableAppRole(enterpriseApp.appRoles || []);
}

function isAlreadyAssignedError(err) {
  return (
    err.statusCode === 400 &&
    String(err.message).includes("Permission being assigned already exists")
  );
}

async function inviteAndAssignGuestUsers(token, enterpriseApp, guestEmails, inviteRedirectUrl) {
  const appRole = pickAssignableAppRole(enterpriseApp.appRoles);

  const inviteOne = async (email) => {
    const invitation = await graphRequest(token, "/invitations", {
      method: "POST",
      body: JSON.stringify({
        invitedUserEmailAddress: email,
        inviteRedirectUrl,
        sendInvitationMessage: true,
      }),
    });
    const userId = invitation && invitation.invitedUser && invitation.invitedUser.id;
    if (!userId) return { email, status: "invited" };
    try {
      await graphRequest(
        token,
        `/servicePrincipals/${enterpriseApp.servicePrincipalId}/appRoleAssignments`,
        {
          method: "POST",
          body: JSON.stringify({
            principalId: userId,
            principalType: "User",
            appRoleId: appRole.id,
            resourceId: enterpriseApp.servicePrincipalId,
          }),
        },
      );
    } catch (err) {
      if (!isAlreadyAssignedError(err)) throw err;
    }
    return { email, userId, status: "invited-and-assigned" };
  };

  // Graph /invitations は app+tenant スコープで throttle が厳しい (実測 ~10 req/s)。
  // chunk 並列化で N+1 直列を解消しつつ並列度を抑えて 429 を避ける。
  const invited = [];
  for (let i = 0; i < guestEmails.length; i += INVITE_CONCURRENCY) {
    const chunk = guestEmails.slice(i, i + INVITE_CONCURRENCY);
    invited.push(...(await Promise.all(chunk.map(inviteOne))));
  }
  return invited;
}

module.exports = {
  INVITE_CONCURRENCY,
  pickAssignableAppRole,
  resolveAppRole,
  inviteAndAssignGuestUsers,
};
