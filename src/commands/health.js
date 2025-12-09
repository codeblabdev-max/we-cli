/**
 * Health Command
 *
 * 서버 인프라 상태 점검:
 * - Quadlet + systemd 컨테이너 상태
 * - PowerDNS DNS 서버 상태
 * - Caddy 리버스 프록시 상태
 * - Podman 컨테이너 상태
 * - 시스템 리소스 (CPU, 메모리, 디스크)
 */

/**
 * Health Command - SSH 기반 서버 인프라 상태 점검
 * MCP 의존성 없이 직접 SSH로 서버 상태를 확인합니다.
 */

import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SERVER_CONFIG = {
  host: process.env.CODEB_SERVER_HOST || '141.164.60.51',
  user: process.env.CODEB_SERVER_USER || 'root',
  port: process.env.CODEB_SERVER_PORT || '22'
};

const HEALTH_THRESHOLDS = {
  cpu: { warning: 70, critical: 90 },
  memory: { warning: 80, critical: 95 },
  disk: { warning: 85, critical: 95 }
};

export async function health(options) {
  const { verbose, json, watch, interval } = options;

  if (watch) {
    return watchHealth(interval, verbose, json);
  }

  await performHealthCheck(verbose, json);
}

async function performHealthCheck(verbose = false, json = false) {
  const spinner = ora('서버 상태 점검 중...').start();
  const results = {
    timestamp: new Date().toISOString(),
    server: SERVER_CONFIG.host,
    status: 'healthy',
    infrastructure: {},
    containers: {},
    resources: {},
    warnings: [],
    errors: []
  };

  try {
    // 1. Quadlet + systemd 상태 확인
    spinner.text = 'Quadlet/systemd 상태 확인 중...';
    results.infrastructure.quadlet = await checkQuadletStatus(verbose);

    // 2. PowerDNS 상태 확인
    spinner.text = 'PowerDNS 상태 확인 중...';
    results.infrastructure.powerdns = await checkPowerDNSStatus(verbose);

    // 3. Caddy 상태 확인
    spinner.text = 'Caddy 상태 확인 중...';
    results.infrastructure.caddy = await checkCaddyStatus(verbose);

    // 4. Podman 컨테이너 상태
    spinner.text = 'Podman 컨테이너 상태 확인 중...';
    results.containers = await checkPodmanContainers(verbose);

    // 5. 시스템 리소스
    spinner.text = '시스템 리소스 확인 중...';
    results.resources = await checkSystemResources();

    // 전체 상태 계산
    results.status = calculateOverallStatus(results);

    // 경고/에러 수집
    collectWarningsAndErrors(results);

    spinner.succeed('서버 상태 점검 완료');

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return results;
    }

    // 결과 출력
    displayResults(results, verbose);
    return results;

  } catch (error) {
    spinner.fail('서버 상태 점검 실패');
    console.log(chalk.red(`\n❌ 오류: ${error.message}\n`));

    if (verbose) {
      console.log(chalk.gray(`서버: ${SERVER_CONFIG.user}@${SERVER_CONFIG.host}`));
      console.log(chalk.gray('SSH 연결을 확인해주세요.'));
    }

    process.exit(1);
  }
}

async function sshExec(command, ignoreError = false) {
  const sshCommand = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${SERVER_CONFIG.user}@${SERVER_CONFIG.host} "${command}"`;

  try {
    const { stdout, stderr } = await execAsync(sshCommand, { timeout: 30000 });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (ignoreError) {
      return { success: false, stdout: '', stderr: error.message, error };
    }
    throw error;
  }
}

async function checkQuadletStatus(verbose) {
  const result = {
    status: 'unknown',
    healthy: false,
    services: [],
    details: null
  };

  try {
    // Quadlet 서비스 파일 확인
    const quadletFiles = await sshExec('ls -la /etc/containers/systemd/*.container 2>/dev/null | wc -l', true);
    const quadletCount = parseInt(quadletFiles.stdout) || 0;

    // Quadlet으로 생성된 systemd 서비스 확인
    const quadletServices = await sshExec('systemctl list-units --type=service --all | grep -E "\\.(container|pod)$" | head -20', true);

    // 개별 서비스 상태 파싱
    if (quadletServices.success && quadletServices.stdout) {
      const lines = quadletServices.stdout.split('\n').filter(l => l.trim());
      result.services = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          name: parts[0],
          loaded: parts[1] === 'loaded',
          active: parts[2] === 'active',
          running: parts[3] === 'running'
        };
      });
    }

    // Quadlet 디렉토리 직접 확인
    const quadletDir = await sshExec('ls /etc/containers/systemd/ 2>/dev/null', true);
    if (quadletDir.success && quadletDir.stdout) {
      result.files = quadletDir.stdout.split('\n').filter(f => f.endsWith('.container') || f.endsWith('.pod'));
    }

    result.healthy = quadletCount > 0 || result.services.length > 0;
    result.status = result.healthy ? 'active' : 'no services';
    result.count = quadletCount;

    if (verbose && quadletDir.stdout) {
      result.details = `Quadlet 파일: ${result.files?.join(', ') || 'none'}`;
    }

  } catch (error) {
    result.status = 'error';
    result.error = error.message;
  }

  return result;
}

async function checkPowerDNSStatus(verbose) {
  const result = {
    status: 'unknown',
    healthy: false,
    services: {
      pdns: { running: false },
      pdnsRecursor: { running: false }
    },
    zones: [],
    details: null
  };

  try {
    // PowerDNS Authoritative 서버 상태
    const pdnsStatus = await sshExec('systemctl is-active pdns 2>/dev/null || podman ps --filter name=pdns --format "{{.Status}}" 2>/dev/null', true);
    result.services.pdns.running = pdnsStatus.stdout.includes('active') || pdnsStatus.stdout.includes('Up');
    result.services.pdns.status = pdnsStatus.stdout || 'not found';

    // PowerDNS Recursor 상태 (있는 경우)
    const recursorStatus = await sshExec('systemctl is-active pdns-recursor 2>/dev/null', true);
    result.services.pdnsRecursor.running = recursorStatus.stdout === 'active';

    // Zone 목록 (pdnsutil 또는 API)
    const zones = await sshExec('pdnsutil list-all-zones 2>/dev/null | head -10', true);
    if (zones.success && zones.stdout) {
      result.zones = zones.stdout.split('\n').filter(z => z.trim());
    }

    // PowerDNS API 상태 확인
    const apiCheck = await sshExec('curl -s http://localhost:8081/api/v1/servers/localhost 2>/dev/null | head -c 100', true);
    result.apiAvailable = apiCheck.success && apiCheck.stdout.includes('localhost');

    result.healthy = result.services.pdns.running;
    result.status = result.healthy ? 'running' : 'stopped';

    if (verbose) {
      result.details = `Zones: ${result.zones.length}개, API: ${result.apiAvailable ? '활성' : '비활성'}`;
    }

  } catch (error) {
    result.status = 'error';
    result.error = error.message;
  }

  return result;
}

async function checkCaddyStatus(verbose) {
  const result = {
    status: 'unknown',
    healthy: false,
    config: null,
    sites: [],
    details: null
  };

  try {
    // Caddy 서비스 상태
    const caddyStatus = await sshExec('systemctl is-active caddy 2>/dev/null || podman ps --filter name=caddy --format "{{.Status}}" 2>/dev/null', true);
    result.running = caddyStatus.stdout.includes('active') || caddyStatus.stdout.includes('Up');
    result.serviceStatus = caddyStatus.stdout || 'not found';

    // Caddy 설정 파일 확인
    const caddyConfig = await sshExec('cat /etc/caddy/Caddyfile 2>/dev/null | head -50', true);
    if (caddyConfig.success && caddyConfig.stdout) {
      result.config = 'found';
      // 설정된 사이트 추출
      const siteMatches = caddyConfig.stdout.match(/^[a-zA-Z0-9.-]+\s*{/gm);
      if (siteMatches) {
        result.sites = siteMatches.map(s => s.replace(/\s*{$/, ''));
      }
    }

    // Caddy Admin API 상태
    const adminApi = await sshExec('curl -s http://localhost:2019/config/ 2>/dev/null | head -c 50', true);
    result.adminApiAvailable = adminApi.success && adminApi.stdout.length > 0;

    // HTTPS 인증서 상태
    const certDir = await sshExec('ls /var/lib/caddy/.local/share/caddy/certificates/ 2>/dev/null | head -5', true);
    if (certDir.success && certDir.stdout) {
      result.certificates = certDir.stdout.split('\n').filter(c => c.trim());
    }

    result.healthy = result.running;
    result.status = result.healthy ? 'running' : 'stopped';

    if (verbose) {
      result.details = `Sites: ${result.sites.length}개, Certs: ${result.certificates?.length || 0}개`;
    }

  } catch (error) {
    result.status = 'error';
    result.error = error.message;
  }

  return result;
}

async function checkPodmanContainers(verbose) {
  const result = {
    total: 0,
    running: 0,
    stopped: 0,
    containers: []
  };

  try {
    // 모든 컨테이너 목록
    const containers = await sshExec('podman ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}"', true);

    if (containers.success && containers.stdout) {
      const lines = containers.stdout.split('\n').filter(l => l.trim());
      result.total = lines.length;

      result.containers = lines.map(line => {
        const [name, status, image, ports] = line.split('|');
        const isRunning = status.toLowerCase().includes('up');

        if (isRunning) result.running++;
        else result.stopped++;

        return {
          name,
          status: isRunning ? 'running' : 'stopped',
          image: image?.split(':')[0] || image,
          ports: ports || 'none'
        };
      });
    }

    // Podman 버전
    const version = await sshExec('podman --version 2>/dev/null', true);
    if (version.success) {
      result.podmanVersion = version.stdout.replace('podman version ', '');
    }

  } catch (error) {
    result.error = error.message;
  }

  return result;
}

async function checkSystemResources() {
  const result = {
    cpu: { usage: 0 },
    memory: { usage: 0, used: '', total: '' },
    disk: { usage: 0, used: '', total: '' }
  };

  try {
    // CPU 사용량
    const cpu = await sshExec("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1", true);
    result.cpu.usage = parseFloat(cpu.stdout) || 0;

    // 메모리 사용량
    const mem = await sshExec("free -h | awk '/^Mem:/ {print $2\"|\"$3\"|\"$3/$2*100}'", true);
    if (mem.success && mem.stdout) {
      const [total, used, usage] = mem.stdout.split('|');
      result.memory = { total, used, usage: parseFloat(usage) || 0 };
    }

    // 디스크 사용량
    const disk = await sshExec("df -h / | awk 'NR==2 {print $2\"|\"$3\"|\"$5}'", true);
    if (disk.success && disk.stdout) {
      const [total, used, usage] = disk.stdout.split('|');
      result.disk = { total, used, usage: parseInt(usage) || 0 };
    }

    // Load Average
    const load = await sshExec("cat /proc/loadavg | awk '{print $1\"|\"$2\"|\"$3}'", true);
    if (load.success && load.stdout) {
      const [load1, load5, load15] = load.stdout.split('|');
      result.loadAverage = { '1m': load1, '5m': load5, '15m': load15 };
    }

    // Uptime
    const uptime = await sshExec("uptime -p", true);
    result.uptime = uptime.stdout || 'unknown';

  } catch (error) {
    result.error = error.message;
  }

  return result;
}

function calculateOverallStatus(results) {
  const { infrastructure, containers, resources } = results;

  // Critical 체크
  if (!infrastructure.caddy?.healthy || !infrastructure.powerdns?.healthy) {
    return 'critical';
  }

  // Warning 체크
  if (resources.cpu?.usage >= HEALTH_THRESHOLDS.cpu.critical ||
      resources.memory?.usage >= HEALTH_THRESHOLDS.memory.critical ||
      resources.disk?.usage >= HEALTH_THRESHOLDS.disk.critical) {
    return 'critical';
  }

  if (resources.cpu?.usage >= HEALTH_THRESHOLDS.cpu.warning ||
      resources.memory?.usage >= HEALTH_THRESHOLDS.memory.warning ||
      resources.disk?.usage >= HEALTH_THRESHOLDS.disk.warning) {
    return 'warning';
  }

  if (containers.stopped > 0) {
    return 'warning';
  }

  return 'healthy';
}

function collectWarningsAndErrors(results) {
  const { infrastructure, containers, resources } = results;

  // Infrastructure 경고
  if (!infrastructure.quadlet?.healthy) {
    results.warnings.push('Quadlet 서비스가 설정되지 않았습니다');
  }
  if (!infrastructure.powerdns?.healthy) {
    results.errors.push('PowerDNS가 실행되지 않고 있습니다');
  }
  if (!infrastructure.caddy?.healthy) {
    results.errors.push('Caddy가 실행되지 않고 있습니다');
  }

  // Container 경고
  if (containers.stopped > 0) {
    results.warnings.push(`${containers.stopped}개 컨테이너가 중지됨`);
  }

  // Resource 경고
  if (resources.cpu?.usage >= HEALTH_THRESHOLDS.cpu.warning) {
    results.warnings.push(`CPU 사용량 높음: ${resources.cpu.usage.toFixed(1)}%`);
  }
  if (resources.memory?.usage >= HEALTH_THRESHOLDS.memory.warning) {
    results.warnings.push(`메모리 사용량 높음: ${resources.memory.usage.toFixed(1)}%`);
  }
  if (resources.disk?.usage >= HEALTH_THRESHOLDS.disk.warning) {
    results.warnings.push(`디스크 사용량 높음: ${resources.disk.usage}%`);
  }
}

function displayResults(results, verbose) {
  const statusIcon = getStatusIcon(results.status);
  const statusColor = getStatusColor(results.status);

  console.log(chalk[statusColor].bold(`\n${statusIcon} 서버 상태: ${results.status.toUpperCase()}`));
  console.log(chalk.gray(`서버: ${results.server} | ${results.timestamp}\n`));

  // Infrastructure 상태
  console.log(chalk.cyan.bold('🏗️  인프라 상태:'));

  // Quadlet
  const quadlet = results.infrastructure.quadlet;
  console.log(chalk[quadlet.healthy ? 'green' : 'yellow'](
    `  ${quadlet.healthy ? '✅' : '⚠️'} Quadlet/systemd: ${quadlet.status}`
  ));
  if (verbose && quadlet.files?.length > 0) {
    quadlet.files.forEach(f => console.log(chalk.gray(`     └─ ${f}`)));
  }

  // PowerDNS
  const pdns = results.infrastructure.powerdns;
  console.log(chalk[pdns.healthy ? 'green' : 'red'](
    `  ${pdns.healthy ? '✅' : '❌'} PowerDNS: ${pdns.status}`
  ));
  if (verbose && pdns.zones?.length > 0) {
    console.log(chalk.gray(`     └─ Zones: ${pdns.zones.join(', ')}`));
  }

  // Caddy
  const caddy = results.infrastructure.caddy;
  console.log(chalk[caddy.healthy ? 'green' : 'red'](
    `  ${caddy.healthy ? '✅' : '❌'} Caddy: ${caddy.status}`
  ));
  if (verbose && caddy.sites?.length > 0) {
    console.log(chalk.gray(`     └─ Sites: ${caddy.sites.join(', ')}`));
  }

  // Containers
  console.log(chalk.cyan.bold('\n📦 컨테이너:'));
  const containers = results.containers;
  console.log(chalk.gray(`  총 ${containers.total}개 (🟢 ${containers.running} 실행 / 🔴 ${containers.stopped} 중지)`));

  if (verbose && containers.containers?.length > 0) {
    containers.containers.forEach(c => {
      const icon = c.status === 'running' ? '🟢' : '🔴';
      console.log(chalk.gray(`  ${icon} ${c.name} - ${c.image}`));
      if (c.ports !== 'none') {
        console.log(chalk.gray(`     └─ ${c.ports}`));
      }
    });
  }

  // Resources
  console.log(chalk.cyan.bold('\n💻 시스템 리소스:'));
  const res = results.resources;

  const cpuColor = getThresholdColor(res.cpu?.usage, HEALTH_THRESHOLDS.cpu);
  console.log(chalk[cpuColor](`  CPU: ${res.cpu?.usage?.toFixed(1) || 0}%`));

  const memColor = getThresholdColor(res.memory?.usage, HEALTH_THRESHOLDS.memory);
  console.log(chalk[memColor](`  메모리: ${res.memory?.usage?.toFixed(1) || 0}% (${res.memory?.used || '-'}/${res.memory?.total || '-'})`));

  const diskColor = getThresholdColor(res.disk?.usage, HEALTH_THRESHOLDS.disk);
  console.log(chalk[diskColor](`  디스크: ${res.disk?.usage || 0}% (${res.disk?.used || '-'}/${res.disk?.total || '-'})`));

  if (res.loadAverage) {
    console.log(chalk.gray(`  Load: ${res.loadAverage['1m']} / ${res.loadAverage['5m']} / ${res.loadAverage['15m']}`));
  }
  if (res.uptime) {
    console.log(chalk.gray(`  Uptime: ${res.uptime}`));
  }

  // Warnings
  if (results.warnings.length > 0) {
    console.log(chalk.yellow.bold('\n⚠️  경고:'));
    results.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
  }

  // Errors
  if (results.errors.length > 0) {
    console.log(chalk.red.bold('\n❌ 오류:'));
    results.errors.forEach(e => console.log(chalk.red(`  • ${e}`)));
  }

  console.log();
}

async function watchHealth(interval, verbose, json) {
  console.log(chalk.cyan(`\n👁️  서버 모니터링 중 (${interval}초 간격)...\n`));
  console.log(chalk.gray('Ctrl+C로 중지\n'));

  const checkInterval = setInterval(async () => {
    console.clear();
    console.log(chalk.cyan.bold(`🔄 마지막 업데이트: ${new Date().toLocaleTimeString()}\n`));
    await performHealthCheck(verbose, json);
  }, interval * 1000);

  await performHealthCheck(verbose, json);

  process.on('SIGINT', () => {
    clearInterval(checkInterval);
    console.log(chalk.gray('\n\n모니터링 중지\n'));
    process.exit(0);
  });
}

function getStatusIcon(status) {
  switch (status) {
    case 'healthy': return '✅';
    case 'warning': return '⚠️';
    case 'critical': return '❌';
    default: return '❓';
  }
}

function getStatusColor(status) {
  switch (status) {
    case 'healthy': return 'green';
    case 'warning': return 'yellow';
    case 'critical': return 'red';
    default: return 'gray';
  }
}

function getThresholdColor(value, thresholds) {
  if (!value) return 'gray';
  if (value >= thresholds.critical) return 'red';
  if (value >= thresholds.warning) return 'yellow';
  return 'green';
}
