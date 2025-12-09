/**
 * Registry Command
 *
 * 서버 레지스트리 관리:
 * - 프로젝트 등록/수정/삭제
 * - 포트 할당 관리
 * - 도메인 매핑
 * - Preview 환경 관리
 */

import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { promisify } from 'util';
import { table } from 'table';

const execAsync = promisify(exec);

const SERVER_CONFIG = {
  host: process.env.CODEB_SERVER_HOST || '141.164.60.51',
  user: process.env.CODEB_SERVER_USER || 'root',
  registryPath: '/opt/codeb/registry.json'
};

export async function registry(action, target, options) {
  const actions = {
    list: listProjects,
    show: showProject,
    add: addProject,
    update: updateProject,
    remove: removeProject,
    ports: listPorts,
    sync: syncRegistry,
    preview: managePreview,
    promote: promotePreview
  };

  if (!actions[action]) {
    console.log(chalk.red(`\n❌ 알 수 없는 액션: ${action}`));
    console.log(chalk.gray('사용 가능한 액션: list, show, add, update, remove, ports, sync, preview, promote\n'));
    process.exit(1);
  }

  await actions[action](target, options);
}

async function sshExec(command, ignoreError = false) {
  const sshCommand = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${SERVER_CONFIG.user}@${SERVER_CONFIG.host} "${command}"`;

  try {
    const { stdout } = await execAsync(sshCommand, { timeout: 30000 });
    return { success: true, stdout: stdout.trim() };
  } catch (error) {
    if (ignoreError) {
      return { success: false, stdout: '', error: error.message };
    }
    throw error;
  }
}

async function getRegistry() {
  const result = await sshExec(`cat ${SERVER_CONFIG.registryPath}`);
  if (!result.success) {
    throw new Error('레지스트리를 읽을 수 없습니다');
  }
  return JSON.parse(result.stdout);
}

async function saveRegistry(registry) {
  registry.updated_at = new Date().toISOString();
  const jsonStr = JSON.stringify(registry, null, 2);
  // base64 인코딩으로 특수문자 이스케이프 문제 해결
  const base64Data = Buffer.from(jsonStr).toString('base64');
  await sshExec(`echo '${base64Data}' | base64 -d > ${SERVER_CONFIG.registryPath}`);
}

async function listProjects(target, options) {
  const spinner = ora('프로젝트 목록 조회 중...').start();

  try {
    const registry = await getRegistry();
    spinner.succeed('프로젝트 목록 조회 완료');

    const projects = Object.entries(registry.projects);

    if (projects.length === 0) {
      console.log(chalk.yellow('\n등록된 프로젝트가 없습니다.\n'));
      return;
    }

    console.log(chalk.cyan.bold(`\n📦 등록된 프로젝트 (${projects.length}개)\n`));

    const tableData = [
      [chalk.bold('프로젝트'), chalk.bold('환경'), chalk.bold('포트'), chalk.bold('도메인'), chalk.bold('상태')]
    ];

    projects.forEach(([name, project]) => {
      Object.entries(project.environments || {}).forEach(([env, config]) => {
        tableData.push([
          name,
          env,
          config.port || '-',
          config.domain || '-',
          config.status === 'running' ? chalk.green('● 실행') : chalk.red('○ 중지')
        ]);
      });
    });

    console.log(table(tableData));

    // Preview 환경 표시
    const previews = Object.entries(registry.previews || {});
    if (previews.length > 0) {
      console.log(chalk.cyan.bold(`\n🔍 Preview 환경 (${previews.length}개)\n`));

      const previewTable = [
        [chalk.bold('프로젝트'), chalk.bold('빌드'), chalk.bold('포트'), chalk.bold('URL'), chalk.bold('만료')]
      ];

      previews.forEach(([key, preview]) => {
        previewTable.push([
          preview.project,
          preview.build || preview.pr || key,
          preview.port,
          preview.url || '-',
          preview.expires_at ? new Date(preview.expires_at).toLocaleDateString() : '-'
        ]);
      });

      console.log(table(previewTable));
    }

  } catch (error) {
    spinner.fail('프로젝트 목록 조회 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function showProject(name, options) {
  if (!name) {
    console.log(chalk.red('\n❌ 프로젝트 이름을 입력해주세요.\n'));
    return;
  }

  const spinner = ora(`프로젝트 정보 조회 중: ${name}`).start();

  try {
    const registry = await getRegistry();
    const project = registry.projects[name];

    if (!project) {
      spinner.fail('프로젝트를 찾을 수 없습니다');
      console.log(chalk.yellow(`\n프로젝트 '${name}'이(가) 등록되어 있지 않습니다.\n`));
      return;
    }

    spinner.succeed('프로젝트 정보 조회 완료');

    console.log(chalk.cyan.bold(`\n📦 프로젝트: ${name}\n`));
    console.log(chalk.gray(`생성일: ${project.created_at}`));
    console.log(chalk.gray(`Git: ${project.git_repo || '-'}`));
    console.log(chalk.gray(`타입: ${project.type || 'nodejs'}`));

    console.log(chalk.cyan.bold('\n환경 설정:'));
    Object.entries(project.environments || {}).forEach(([env, config]) => {
      console.log(chalk.white(`\n  ${env}:`));
      console.log(chalk.gray(`    포트: ${config.port}`));
      console.log(chalk.gray(`    도메인: ${config.domain || '-'}`));
      console.log(chalk.gray(`    컨테이너: ${config.container || '-'}`));
      console.log(chalk.gray(`    상태: ${config.status || 'unknown'}`));
    });

    // 관련 Preview 환경
    const previews = Object.entries(registry.previews || {})
      .filter(([_, p]) => p.project === name);

    if (previews.length > 0) {
      console.log(chalk.cyan.bold('\nPreview 환경:'));
      previews.forEach(([key, preview]) => {
        console.log(chalk.gray(`  - ${key}: ${preview.url} (포트: ${preview.port})`));
      });
    }

    console.log();

  } catch (error) {
    spinner.fail('프로젝트 정보 조회 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function addProject(name, options) {
  if (!name) {
    console.log(chalk.red('\n❌ 프로젝트 이름을 입력해주세요.\n'));
    return;
  }

  const spinner = ora(`프로젝트 등록 중: ${name}`).start();

  try {
    const registry = await getRegistry();

    if (registry.projects[name]) {
      spinner.fail('이미 등록된 프로젝트입니다');
      console.log(chalk.yellow(`\n프로젝트 '${name}'이(가) 이미 존재합니다. 'update' 명령을 사용하세요.\n`));
      return;
    }

    // 포트 할당
    const stagingPort = options.port ? parseInt(options.port) + 100 : registry.ports.next_available.staging++;
    const productionPort = options.port ? parseInt(options.port) : registry.ports.next_available.production++;

    // 도메인 설정 - 기본값 one-q.xyz
    const baseDomain = options.domain || 'one-q.xyz';

    registry.projects[name] = {
      created_at: new Date().toISOString(),
      type: options.type || 'nodejs',
      git_repo: options.git || null,
      environments: {
        staging: {
          port: stagingPort,
          domain: `${name}-staging.${baseDomain}`,
          container: `${name}-staging`,
          status: 'pending'
        },
        production: {
          port: productionPort,
          domain: `${name}.${baseDomain}`,
          container: `${name}-production`,
          status: 'pending'
        }
      }
    };

    await saveRegistry(registry);

    spinner.succeed('프로젝트 등록 완료');

    console.log(chalk.green(`\n✅ 프로젝트 '${name}' 등록됨\n`));
    console.log(chalk.cyan('할당된 설정:'));
    console.log(chalk.gray(`  Staging:`));
    console.log(chalk.gray(`    - 포트: ${stagingPort}`));
    console.log(chalk.gray(`    - 도메인: ${name}-staging.${baseDomain}`));
    console.log(chalk.gray(`  Production:`));
    console.log(chalk.gray(`    - 포트: ${productionPort}`));
    console.log(chalk.gray(`    - 도메인: ${name}.${baseDomain}`));
    console.log();

  } catch (error) {
    spinner.fail('프로젝트 등록 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function updateProject(name, options) {
  if (!name) {
    console.log(chalk.red('\n❌ 프로젝트 이름을 입력해주세요.\n'));
    return;
  }

  const spinner = ora(`프로젝트 업데이트 중: ${name}`).start();

  try {
    const registry = await getRegistry();
    const project = registry.projects[name];

    if (!project) {
      spinner.fail('프로젝트를 찾을 수 없습니다');
      return;
    }

    // 옵션에 따라 업데이트
    if (options.git) project.git_repo = options.git;
    if (options.type) project.type = options.type;
    if (options.status && options.env) {
      if (project.environments[options.env]) {
        project.environments[options.env].status = options.status;
      }
    }
    if (options.domain && options.env) {
      if (project.environments[options.env]) {
        project.environments[options.env].domain = options.domain;
      }
    }

    project.updated_at = new Date().toISOString();
    await saveRegistry(registry);

    spinner.succeed('프로젝트 업데이트 완료');
    console.log(chalk.green(`\n✅ 프로젝트 '${name}' 업데이트됨\n`));

  } catch (error) {
    spinner.fail('프로젝트 업데이트 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function removeProject(name, options) {
  if (!name) {
    console.log(chalk.red('\n❌ 프로젝트 이름을 입력해주세요.\n'));
    return;
  }

  const spinner = ora(`프로젝트 삭제 중: ${name}`).start();

  try {
    const registry = await getRegistry();

    if (!registry.projects[name]) {
      spinner.fail('프로젝트를 찾을 수 없습니다');
      return;
    }

    // 관련 Preview도 삭제
    Object.keys(registry.previews || {}).forEach(key => {
      if (registry.previews[key].project === name) {
        delete registry.previews[key];
      }
    });

    delete registry.projects[name];
    await saveRegistry(registry);

    spinner.succeed('프로젝트 삭제 완료');
    console.log(chalk.green(`\n✅ 프로젝트 '${name}' 삭제됨\n`));

  } catch (error) {
    spinner.fail('프로젝트 삭제 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function listPorts(target, options) {
  const spinner = ora('포트 현황 조회 중...').start();

  try {
    const registry = await getRegistry();
    spinner.succeed('포트 현황 조회 완료');

    console.log(chalk.cyan.bold('\n🔌 포트 현황\n'));

    // 예약된 포트
    console.log(chalk.white.bold('예약된 포트:'));
    Object.entries(registry.ports.reserved).forEach(([port, service]) => {
      console.log(chalk.gray(`  ${port}: ${service}`));
    });

    // 포트 범위
    console.log(chalk.white.bold('\n포트 범위:'));
    Object.entries(registry.ports.range).forEach(([env, range]) => {
      const next = registry.ports.next_available[env];
      console.log(chalk.gray(`  ${env}: ${range} (다음: ${next})`));
    });

    // 사용 중인 포트
    console.log(chalk.white.bold('\n사용 중인 포트:'));
    const usedPorts = [];
    Object.entries(registry.projects).forEach(([name, project]) => {
      Object.entries(project.environments || {}).forEach(([env, config]) => {
        if (config.port) {
          usedPorts.push({ port: config.port, project: name, env });
        }
      });
    });

    Object.entries(registry.previews || {}).forEach(([key, preview]) => {
      usedPorts.push({ port: preview.port, project: preview.project, env: `preview:${key}` });
    });

    usedPorts.sort((a, b) => a.port - b.port);
    usedPorts.forEach(({ port, project, env }) => {
      console.log(chalk.gray(`  ${port}: ${project} (${env})`));
    });

    console.log();

  } catch (error) {
    spinner.fail('포트 현황 조회 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function syncRegistry(target, options) {
  const spinner = ora('레지스트리 동기화 중...').start();

  try {
    const registry = await getRegistry();

    // 실제 컨테이너 상태 확인
    const containersResult = await sshExec('podman ps -a --format "{{.Names}}|{{.Status}}"', true);
    const runningContainers = new Set();

    if (containersResult.success && containersResult.stdout) {
      containersResult.stdout.split('\n').forEach(line => {
        const [name, status] = line.split('|');
        if (status && status.toLowerCase().includes('up')) {
          runningContainers.add(name);
        }
      });
    }

    // 프로젝트 상태 업데이트
    let updated = 0;
    Object.entries(registry.projects).forEach(([name, project]) => {
      Object.entries(project.environments || {}).forEach(([env, config]) => {
        const containerName = config.container || `${name}-${env}`;
        const isRunning = runningContainers.has(containerName);
        const newStatus = isRunning ? 'running' : 'stopped';

        if (config.status !== newStatus) {
          config.status = newStatus;
          updated++;
        }
      });
    });

    // 만료된 Preview 정리
    const now = new Date();
    Object.entries(registry.previews || {}).forEach(([key, preview]) => {
      if (preview.expires_at && new Date(preview.expires_at) < now) {
        delete registry.previews[key];
        updated++;
      }
    });

    await saveRegistry(registry);

    spinner.succeed('레지스트리 동기화 완료');
    console.log(chalk.green(`\n✅ ${updated}개 항목 업데이트됨\n`));

  } catch (error) {
    spinner.fail('레지스트리 동기화 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function managePreview(target, options) {
  // target: create, list, remove
  const subAction = target || 'list';

  if (subAction === 'list') {
    await listPreviews(options);
  } else if (subAction === 'create') {
    await createPreview(options);
  } else if (subAction === 'remove') {
    await removePreview(options);
  } else {
    console.log(chalk.red(`\n❌ 알 수 없는 서브 액션: ${subAction}`));
    console.log(chalk.gray('사용: preview [create|list|remove]\n'));
  }
}

async function listPreviews(options) {
  const spinner = ora('Preview 환경 조회 중...').start();

  try {
    const registry = await getRegistry();
    const previews = Object.entries(registry.previews || {});

    spinner.succeed('Preview 환경 조회 완료');

    if (previews.length === 0) {
      console.log(chalk.yellow('\n활성화된 Preview 환경이 없습니다.\n'));
      return;
    }

    console.log(chalk.cyan.bold(`\n🔍 Preview 환경 (${previews.length}개)\n`));

    previews.forEach(([key, preview]) => {
      const isExpired = preview.expires_at && new Date(preview.expires_at) < new Date();
      const status = isExpired ? chalk.red('만료됨') : chalk.green('활성');

      console.log(chalk.white.bold(`  ${key}:`));
      console.log(chalk.gray(`    프로젝트: ${preview.project}`));
      console.log(chalk.gray(`    빌드: ${preview.build || preview.pr || '-'}`));
      console.log(chalk.gray(`    브랜치: ${preview.branch || '-'}`));
      console.log(chalk.gray(`    포트: ${preview.port}`));
      console.log(chalk.gray(`    URL: ${preview.url}`));
      console.log(chalk.gray(`    상태: ${status}`));
      console.log(chalk.gray(`    생성: ${preview.created_at}`));
      if (preview.expires_at) {
        console.log(chalk.gray(`    만료: ${preview.expires_at}`));
      }
      console.log();
    });

  } catch (error) {
    spinner.fail('Preview 환경 조회 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function createPreview(options) {
  const { project, build, branch, pr, ttl } = options;

  if (!project) {
    console.log(chalk.red('\n❌ --project 옵션이 필요합니다.\n'));
    return;
  }

  const buildId = build || pr || `build-${Date.now()}`;
  const spinner = ora(`Preview 환경 생성 중: ${project}/${buildId}`).start();

  try {
    const registry = await getRegistry();

    // 프로젝트 존재 확인
    if (!registry.projects[project]) {
      spinner.fail('프로젝트를 찾을 수 없습니다');
      console.log(chalk.yellow(`\n먼저 'we registry add ${project}'로 프로젝트를 등록해주세요.\n`));
      return;
    }

    // 포트 할당
    const port = registry.ports.next_available.preview++;
    const baseDomain = registry.server.domains[1] || registry.server.domains[0] || 'one-q.xyz';
    const previewKey = `${project}-${buildId}`;

    // TTL 계산 (기본 24시간)
    const ttlHours = parseInt(ttl) || 24;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    registry.previews[previewKey] = {
      project,
      build: buildId,
      branch: branch || null,
      pr: pr || null,
      port,
      url: `https://${previewKey}.${baseDomain}`,
      container: `${previewKey}`,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString()
    };

    await saveRegistry(registry);

    spinner.succeed('Preview 환경 생성 완료');

    console.log(chalk.green(`\n✅ Preview 환경 생성됨\n`));
    console.log(chalk.cyan('설정 정보:'));
    console.log(chalk.gray(`  키: ${previewKey}`));
    console.log(chalk.gray(`  포트: ${port}`));
    console.log(chalk.gray(`  URL: https://${previewKey}.${baseDomain}`));
    console.log(chalk.gray(`  만료: ${expiresAt.toLocaleString()} (${ttlHours}시간 후)`));
    console.log();

    // JSON 출력 옵션
    if (options.json) {
      console.log(JSON.stringify(registry.previews[previewKey], null, 2));
    }

  } catch (error) {
    spinner.fail('Preview 환경 생성 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function removePreview(options) {
  const { key, project, build } = options;

  const previewKey = key || (project && build ? `${project}-${build}` : null);

  if (!previewKey) {
    console.log(chalk.red('\n❌ --key 또는 --project와 --build 옵션이 필요합니다.\n'));
    return;
  }

  const spinner = ora(`Preview 환경 삭제 중: ${previewKey}`).start();

  try {
    const registry = await getRegistry();

    if (!registry.previews[previewKey]) {
      spinner.fail('Preview 환경을 찾을 수 없습니다');
      return;
    }

    delete registry.previews[previewKey];
    await saveRegistry(registry);

    spinner.succeed('Preview 환경 삭제 완료');
    console.log(chalk.green(`\n✅ Preview '${previewKey}' 삭제됨\n`));

  } catch (error) {
    spinner.fail('Preview 환경 삭제 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}

async function promotePreview(previewKey, options) {
  if (!previewKey) {
    console.log(chalk.red('\n❌ Preview 키를 입력해주세요.\n'));
    return;
  }

  const targetEnv = options.to || 'staging';
  const spinner = ora(`Preview를 ${targetEnv}으로 승격 중: ${previewKey}`).start();

  try {
    const registry = await getRegistry();
    const preview = registry.previews[previewKey];

    if (!preview) {
      spinner.fail('Preview 환경을 찾을 수 없습니다');
      return;
    }

    const project = registry.projects[preview.project];
    if (!project) {
      spinner.fail('프로젝트를 찾을 수 없습니다');
      return;
    }

    // 승격 로직: Preview의 이미지/빌드를 타겟 환경에 배포
    console.log(chalk.cyan(`\n승격 정보:`));
    console.log(chalk.gray(`  소스: ${previewKey}`));
    console.log(chalk.gray(`  빌드: ${preview.build}`));
    console.log(chalk.gray(`  대상: ${preview.project} / ${targetEnv}`));
    console.log(chalk.gray(`  도메인: ${project.environments[targetEnv]?.domain}`));

    // 실제 배포는 deploy 명령어나 GitHub Actions에서 처리
    spinner.succeed('승격 준비 완료');

    console.log(chalk.yellow(`\n다음 명령어로 배포를 완료하세요:`));
    console.log(chalk.white(`  we deploy ${preview.project} -e ${targetEnv} --image ${preview.build}\n`));

  } catch (error) {
    spinner.fail('Preview 승격 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));
  }
}
