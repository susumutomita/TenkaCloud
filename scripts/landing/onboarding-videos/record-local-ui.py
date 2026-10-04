"""Record isolated Local UI with synthetic exercise adapter; no AWS or Docker mutation.
Run: python3 scripts/landing/onboarding-videos/record-local-ui.py --output .cache/local-ui-video/raw
Requires installed Bun, ffmpeg, and Chrome (or HOST_E2E_CHROMIUM). Uses a fresh host DB.
"""
from pathlib import Path
import argparse
import json
import os
import re
import shutil
import subprocess

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
args=parser.parse_args()
repo=Path(__file__).resolve().parents[3]
os.chdir(repo)
output=Path(args.output).resolve()
output.mkdir(parents=True,exist_ok=True)
source=Path('scripts/local-host/tests/browser-e2e.ts')
s=source.read_text()
s=re.sub(r'from "(\.[^"]+)"',lambda m:'from '+json.dumps(str((source.parent/m.group(1)).resolve())),s)
s=s.replace('const root = fileURLToPath(new URL("../../../", import.meta.url));','const root = '+json.dumps(str(repo))+';')
s=s.replace('const STEP_TIMEOUT = 90_000;','const STEP_TIMEOUT = 15_000;')
s=s.replace('const reviewArtifacts = join(root, ".tenkacloud/host-ui-review");','const reviewArtifacts = '+json.dumps(str(output.parent/'verified-ui'))+';')
s=s.replace('import { existsSync, mkdirSync }','import { existsSync, mkdirSync, writeFileSync }')
s=s.replace('const STEP_TIMEOUT = 15_000;', '''const STEP_TIMEOUT = 30_000;
const recordingDir = process.env.LOCAL_UI_RECORDING_DIR!;
mkdirSync(recordingDir, {recursive:true});
const videoPaths: string[] = [];
const rolePaths: Record<string,string> = {};
const pageStarts = new Map<Page,number>();
const editPoints: Record<string,number> = {};
let uiErrors = 0;
async function recordedContext(browser: Browser): Promise<BrowserContext> {
 const context = await browser.newContext({locale:'en-US', viewport:{width:1280,height:720}, recordVideo:{dir:recordingDir,size:{width:1280,height:720}}});
 await context.exposeBinding('recordingUiError', () => { uiErrors += 1; });
 await context.addInitScript(() => {
  const seenErrors = new WeakSet<Element>();
  const apply = () => {
   if (!document.documentElement) return;
   if (!document.getElementById('recording-style')) {
    const style = document.createElement('style'); style.id='recording-style';
    style.textContent='[data-recording-secret]{color:transparent!important;background:#17283f!important;text-shadow:none!important;user-select:none!important}[data-recording-secret] *{color:transparent!important;text-shadow:none!important}input[type=password]{color:transparent!important;text-shadow:none!important}#recording-note{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#0d1624;color:#7ce3d8;padding:8px 16px;font:14px Arial;text-align:center;pointer-events:none}';
    document.documentElement.append(style);
   }
   if(document.body && !document.getElementById('recording-note')) {const note=document.createElement('div');note.id='recording-note';note.textContent='LOCAL UI / isolated SQLite + synthetic exercise adapter / No AWS or Docker deployment / credentials and answers hidden';document.body.append(note);}
   if(document.body) {
    for (const alert of document.querySelectorAll('[class*="awsui_type-error_"]')) {
     if (!seenErrors.has(alert)) { seenErrors.add(alert); void (window as unknown as {recordingUiError:()=>Promise<void>}).recordingUiError(); }
    }
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {const node=walker.currentNode;const parent=node.parentElement;if(parent&&!parent.hasAttribute('data-recording-secret')&&/TC\\{|[A-Za-z0-9_-]{43}/u.test(node.textContent??''))parent.setAttribute('data-recording-secret','');}
    for(const input of document.querySelectorAll('input,textarea')) {if(/TC\\{|[A-Za-z0-9_-]{43}/u.test((input as HTMLInputElement).value)&&!input.hasAttribute('data-recording-secret'))input.setAttribute('data-recording-secret','');}
   }
  };
  new MutationObserver(apply).observe(document,{childList:true,subtree:true});
  document.addEventListener('input',apply,true);document.addEventListener('DOMContentLoaded',apply);apply();
 });
 context.on('page',page=>{pageStarts.set(page,Date.now());page.on('pageerror',()=>{uiErrors+=1;});void page.video()?.path().then(path=>{videoPaths.push(path);});});
 return context;
}
''')
s=s.replace('browser.newContext({ locale: "en-US" })','recordedContext(browser)')
s=s.replace('browser = await chromium.launch({ executablePath: chromiumPath() });','browser = await chromium.launch({ executablePath: chromiumPath(), slowMo: 300 });')
s=s.replace('  await page.screenshot({ path: join(reviewArtifacts, filename), fullPage: true });','  await page.screenshot({ path: join(reviewArtifacts, filename), fullPage: true });\n  rolePaths[filename] = await page.video()!.path();\n  await page.waitForTimeout(2500);')
s=s.replace('  await page.getByTestId("deploy-prompt-now").click();','  await page.waitForTimeout(2500);\n  await page.getByTestId("deploy-prompt-now").click();')
# Persist only generated recording paths; all fixture secrets remain in memory.
s=s.replace('    await organizer.getByRole("heading", { name: "Learning goals", exact: true }).waitFor();', '    await organizer.getByRole("heading", { name: "Learning goals", exact: true }).waitFor();\n    await organizer.waitForTimeout(2000);')
s=s.replace('    await startEvent(organizer);', '    await startEvent(organizer);\n    await organizer.waitForTimeout(1000);\n    editPoints.openingEnd = (Date.now()-pageStarts.get(organizer)!)/1000;')
s=s.replace('    await endAndTearDown(organizer);', '    editPoints.teardownStart = (Date.now()-pageStarts.get(organizer)!)/1000;\n    await endAndTearDown(organizer);\n    assert.equal(uiErrors,0,"Recording must contain no error alerts or uncaught page errors.");\n    writeFileSync(join(recordingDir,"ui-validation.json"),JSON.stringify({uiErrors,descriptionAndLearningGoals:true}));')
s += "\nprocess.on('exit',()=>writeFileSync(join(recordingDir,'edit-points.json'),JSON.stringify(editPoints)));\n"

s=s.replace('  await page.goto(`${info.participant}/login#invite=${encodeURIComponent(teamKey)}`);', '  await page.goto(`${info.participant}/login`);\n  await page.waitForTimeout(1200);\n  try { await page.locator(\'input[type=\"password\"]\').fill(teamKey); } catch { throw new Error(\"Could not enter the synthetic team key.\"); }\n  await page.waitForTimeout(1800);')
s=s.replace('  await page.getByLabel(/Flag/u).first().fill(flag);', '  await page.getByLabel(/Flag/u).first().fill(flag);\n  await page.waitForTimeout(1500);')
s=s.replace('  await page.goto(`${info.participant}/scoreboard`);', '  await page.waitForTimeout(1500);\n  await page.goto(`${info.participant}/scoreboard`);')
s=s.replace('      .getByText("Removed")\n      .waitFor({ timeout: STEP_TIMEOUT });','      .getByText("Removed")\n      .waitFor({ timeout: STEP_TIMEOUT });\n  await page.waitForTimeout(2000);')
s += "\nprocess.on('exit',()=>writeFileSync(join(recordingDir,'video-paths.json'),JSON.stringify(videoPaths)));\nprocess.on('exit',()=>writeFileSync(join(recordingDir,'role-paths.json'),JSON.stringify(rolePaths)));\n"
s=s.replace('fullPage: true', 'fullPage: false')
driver=repo/'.cache/local-ui-recording-driver.ts'
driver.parent.mkdir(exist_ok=True)
driver.write_text(s)
bun=shutil.which('bun')
ffmpeg=shutil.which('ffmpeg')
if not bun or not ffmpeg:
    raise SystemExit('Bun and ffmpeg must already be installed.')
revision=next(x['revision'] for x in json.loads((repo/'node_modules/playwright-core/browsers.json').read_text())['browsers'] if x['name']=='ffmpeg')
browsers=repo/'.cache/local-ui-pw'
folder=browsers/('ffmpeg-'+revision)
folder.mkdir(parents=True,exist_ok=True)
link=folder/('ffmpeg-mac' if os.uname().sysname=='Darwin' else 'ffmpeg-linux')
if not link.exists():
    link.symlink_to(ffmpeg)
chrome=os.environ.get('HOST_E2E_CHROMIUM','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if not Path(chrome).is_file():
    raise SystemExit('Set HOST_E2E_CHROMIUM to an installed Chromium executable.')
env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(browsers),'HOST_E2E_CHROMIUM':chrome,'HOST_E2E_ENGINE':'fixture','HOST_E2E_ADMIN_PORT':'0','HOST_E2E_PARTICIPANT_PORT':'0','LOCAL_UI_RECORDING_DIR':str(output)}
subprocess.run([bun,'run','build:host'],check=True,env=env)
subprocess.run([bun,str(driver)],check=True,env=env)
print('Recorded isolated Local UI:',output)
