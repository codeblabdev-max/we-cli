/**
 * GitHub Secrets 자동 설정 명령
 * gh CLI를 사용하여 배포에 필요한 Secrets 자동 등록
 */

import chalk from 'chalk';
import ora from 'ora';
import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import inquirer from 'inquirer';

// 기본 설정
const DEFAULT_HOST = '141.164.60.51';
const DEFAULT_USER = 'root';
const SSH_KEY_PATHS = [
  path.join(homedir(), '.ssh', 'id_ed25519'),
  path.join(homedir(), '.ssh', 'id_rsa'),
];

/**
 * gh CLI 설치 확인
 */
function checkGhCli() {
  try {
    execSync('gh --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * gh CLI 인증 확인
 */
function checkGhAuth() {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 현재 디렉토리의 GitHub 저장소 정보 가져오기
 */
function getRepoInfo() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    // https://github.com/owner/repo.git 또는 git@github.com:owner/repo.git
    let match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SSH 키 찾기
 */
function findSshKey() {
  for (const keyPath of SSH_KEY_PATHS) {
    if (existsSync(keyPath)) {
      return keyPath;
    }
  }
  return null;
}

/**
 * GitHub Secret 설정
 */
function setSecret(repo, name, value) {
  try {
    const result = spawnSync('gh', ['secret', 'set', name, '-R', repo], {
      input: value,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 현재 Secrets 목록 조회
 */
function listSecrets(repo) {
  try {
    const result = execSync(`gh secret list -R ${repo}`, { encoding: 'utf-8' });
    return result.split('\n').filter(line => line.trim()).map(line => {
      const [name] = line.split('\t');
      return name;
    });
  } catch {
    return [];
  }
}

/**
 * secrets 명령 핸들러
 */
export async function secrets(action, target, options) {
  console.log(chalk.cyan('\n🔐 GitHub Secrets 관리\n'));

  // gh CLI 확인
  if (!checkGhCli()) {
    console.log(chalk.red('❌ gh CLI가 설치되어 있지 않습니다.'));
    console.log(chalk.yellow('\n설치 방법:'));
    console.log(chalk.gray('  macOS:   brew install gh'));
    console.log(chalk.gray('  Windows: winget install GitHub.cli'));
    console.log(chalk.gray('  Linux:   https://github.com/cli/cli#installation'));
    return;
  }

  // gh 인증 확인
  if (!checkGhAuth()) {
    console.log(chalk.yellow('⚠️  GitHub 인증이 필요합니다.'));
    console.log(chalk.gray('\n  gh auth login\n'));

    const { doLogin } = await inquirer.prompt([{
      type: 'confirm',
      name: 'doLogin',
      message: '지금 로그인하시겠습니까?',
      default: true
    }]);

    if (doLogin) {
      execSync('gh auth login', { stdio: 'inherit' });
    } else {
      return;
    }
  }

  // 저장소 정보
  let repo = target;
  if (!repo) {
    const repoInfo = getRepoInfo();
    if (repoInfo) {
      repo = `${repoInfo.owner}/${repoInfo.repo}`;
    }
  }

  if (!repo) {
    console.log(chalk.red('❌ GitHub 저장소를 찾을 수 없습니다.'));
    console.log(chalk.gray('  사용법: we secrets setup owner/repo'));
    return;
  }

  console.log(chalk.gray(`📦 저장소: ${repo}\n`));

  switch (action) {
    case 'setup':
    case 'init':
      await setupSecrets(repo, options);
      break;
    case 'list':
      await listSecretsAction(repo);
      break;
    case 'add':
    case 'set':
      await addSecret(repo, target, options);
      break;
    case 'remove':
    case 'delete':
      await removeSecret(repo, target, options);
      break;
    case 'check':
    case 'verify':
      await checkSecrets(repo);
      break;
    default:
      console.log(chalk.yellow('사용 가능한 작업:'));
      console.log(chalk.gray('  setup  - 배포 Secrets 자동 설정 (HOST, USERNAME, SSH_KEY)'));
      console.log(chalk.gray('  list   - 현재 설정된 Secrets 목록'));
      console.log(chalk.gray('  add    - Secret 추가'));
      console.log(chalk.gray('  remove - Secret 삭제'));
      console.log(chalk.gray('  check  - 필수 Secrets 확인'));
  }
}

/**
 * 배포 Secrets 자동 설정
 */
async function setupSecrets(repo, options) {
  console.log(chalk.cyan('🚀 배포 Secrets 자동 설정\n'));

  // 기존 secrets 확인
  const existingSecrets = listSecrets(repo);
  console.log(chalk.gray(`현재 설정된 Secrets: ${existingSecrets.length}개`));
  if (existingSecrets.length > 0) {
    console.log(chalk.gray(`  ${existingSecrets.join(', ')}\n`));
  }

  // 값 수집
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'host',
      message: '서버 호스트 (HOST):',
      default: options.host || DEFAULT_HOST,
    },
    {
      type: 'input',
      name: 'username',
      message: '서버 사용자 (USERNAME):',
      default: options.user || DEFAULT_USER,
    },
    {
      type: 'input',
      name: 'sshKeyPath',
      message: 'SSH 개인키 경로:',
      default: findSshKey() || '~/.ssh/id_ed25519',
    },
    {
      type: 'confirm',
      name: 'setEnvProduction',
      message: '.env.production 파일도 Secret으로 등록하시겠습니까?',
      default: existsSync('.env.production'),
    }
  ]);

  // SSH 키 읽기
  const sshKeyPath = answers.sshKeyPath.replace('~', homedir());
  let sshKey;
  try {
    sshKey = readFileSync(sshKeyPath, 'utf-8');
  } catch (err) {
    console.log(chalk.red(`❌ SSH 키를 읽을 수 없습니다: ${sshKeyPath}`));
    return;
  }

  // Secrets 설정
  const spinner = ora('Secrets 설정 중...').start();
  const results = [];

  // HOST
  spinner.text = 'HOST 설정 중...';
  if (setSecret(repo, 'HOST', answers.host)) {
    results.push({ name: 'HOST', status: '✅' });
  } else {
    results.push({ name: 'HOST', status: '❌' });
  }

  // USERNAME
  spinner.text = 'USERNAME 설정 중...';
  if (setSecret(repo, 'USERNAME', answers.username)) {
    results.push({ name: 'USERNAME', status: '✅' });
  } else {
    results.push({ name: 'USERNAME', status: '❌' });
  }

  // SSH_KEY
  spinner.text = 'SSH_KEY 설정 중...';
  if (setSecret(repo, 'SSH_KEY', sshKey)) {
    results.push({ name: 'SSH_KEY', status: '✅' });
  } else {
    results.push({ name: 'SSH_KEY', status: '❌' });
  }

  // ENV_PRODUCTION (선택)
  if (answers.setEnvProduction && existsSync('.env.production')) {
    spinner.text = 'ENV_PRODUCTION 설정 중...';
    const envContent = readFileSync('.env.production', 'utf-8');
    if (setSecret(repo, 'ENV_PRODUCTION', envContent)) {
      results.push({ name: 'ENV_PRODUCTION', status: '✅' });
    } else {
      results.push({ name: 'ENV_PRODUCTION', status: '❌' });
    }
  }

  spinner.stop();

  // 결과 출력
  console.log(chalk.cyan('\n📋 설정 결과:\n'));
  results.forEach(r => {
    console.log(`  ${r.status} ${r.name}`);
  });

  const failCount = results.filter(r => r.status === '❌').length;
  if (failCount === 0) {
    console.log(chalk.green('\n✅ 모든 Secrets가 설정되었습니다!'));
    console.log(chalk.gray('\n이제 git push하면 GitHub Actions가 자동으로 배포합니다.'));
  } else {
    console.log(chalk.yellow(`\n⚠️  ${failCount}개 Secret 설정 실패`));
  }
}

/**
 * Secrets 목록 조회
 */
async function listSecretsAction(repo) {
  const spinner = ora('Secrets 조회 중...').start();

  try {
    const result = execSync(`gh secret list -R ${repo}`, { encoding: 'utf-8' });
    spinner.stop();

    if (!result.trim()) {
      console.log(chalk.yellow('설정된 Secret이 없습니다.'));
      return;
    }

    console.log(chalk.cyan('📋 설정된 Secrets:\n'));
    const lines = result.trim().split('\n');
    lines.forEach(line => {
      const [name, updated] = line.split('\t');
      console.log(`  🔑 ${chalk.white(name)} ${chalk.gray(`(${updated})`)}`);
    });
  } catch (err) {
    spinner.stop();
    console.log(chalk.red('❌ Secrets 조회 실패'));
    console.log(chalk.gray(err.message));
  }
}

/**
 * Secret 추가
 */
async function addSecret(repo, name, options) {
  if (!name) {
    const { secretName, secretValue } = await inquirer.prompt([
      {
        type: 'input',
        name: 'secretName',
        message: 'Secret 이름:',
        validate: v => v.trim() ? true : 'Secret 이름을 입력하세요'
      },
      {
        type: 'password',
        name: 'secretValue',
        message: 'Secret 값:',
        mask: '*',
        validate: v => v.trim() ? true : 'Secret 값을 입력하세요'
      }
    ]);
    name = secretName;
    options.value = secretValue;
  }

  const spinner = ora(`${name} 설정 중...`).start();

  if (setSecret(repo, name, options.value)) {
    spinner.succeed(`${name} 설정 완료`);
  } else {
    spinner.fail(`${name} 설정 실패`);
  }
}

/**
 * Secret 삭제
 */
async function removeSecret(repo, name, options) {
  if (!name) {
    const secrets = listSecrets(repo);
    if (secrets.length === 0) {
      console.log(chalk.yellow('삭제할 Secret이 없습니다.'));
      return;
    }

    const { secretName } = await inquirer.prompt([{
      type: 'list',
      name: 'secretName',
      message: '삭제할 Secret 선택:',
      choices: secrets
    }]);
    name = secretName;
  }

  if (!options.force) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `정말 ${name}을(를) 삭제하시겠습니까?`,
      default: false
    }]);
    if (!confirm) return;
  }

  const spinner = ora(`${name} 삭제 중...`).start();

  try {
    execSync(`gh secret delete ${name} -R ${repo}`, { stdio: 'pipe' });
    spinner.succeed(`${name} 삭제 완료`);
  } catch {
    spinner.fail(`${name} 삭제 실패`);
  }
}

/**
 * 필수 Secrets 확인
 */
async function checkSecrets(repo) {
  console.log(chalk.cyan('🔍 필수 Secrets 확인\n'));

  const requiredSecrets = ['HOST', 'USERNAME', 'SSH_KEY'];
  const optionalSecrets = ['ENV_PRODUCTION', 'GHCR_TOKEN'];

  const existingSecrets = listSecrets(repo);

  console.log(chalk.white('필수 Secrets:'));
  requiredSecrets.forEach(name => {
    const exists = existingSecrets.includes(name);
    console.log(`  ${exists ? '✅' : '❌'} ${name}`);
  });

  console.log(chalk.white('\n선택 Secrets:'));
  optionalSecrets.forEach(name => {
    const exists = existingSecrets.includes(name);
    console.log(`  ${exists ? '✅' : '⚪'} ${name}`);
  });

  const missingRequired = requiredSecrets.filter(s => !existingSecrets.includes(s));
  if (missingRequired.length > 0) {
    console.log(chalk.yellow(`\n⚠️  누락된 필수 Secrets: ${missingRequired.join(', ')}`));
    console.log(chalk.gray('  we secrets setup 명령으로 설정하세요.'));
  } else {
    console.log(chalk.green('\n✅ 모든 필수 Secrets가 설정되어 있습니다!'));
  }
}
