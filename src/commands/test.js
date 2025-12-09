#!/usr/bin/env node

/**
 * /we:test - E2E 테스트 명령어
 *
 * Playwright 기반 E2E 테스트 실행 및 관리
 * e2e-test-strategist 에이전트와 연동
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { execSync, spawn } from 'child_process';

const SERVER_HOST = '141.164.60.51';

// Check if Playwright is installed
async function checkPlaywright() {
  try {
    execSync('npx playwright --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Install Playwright
async function installPlaywright() {
  console.log(chalk.cyan('\n📦 Installing Playwright...\n'));
  execSync('npm install -D @playwright/test', { stdio: 'inherit' });
  execSync('npx playwright install', { stdio: 'inherit' });
}

// Check if test directory exists
async function checkTestDir() {
  const dirs = ['tests', 'e2e', '__tests__', 'test'];
  for (const dir of dirs) {
    try {
      await fs.access(join(process.cwd(), dir));
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

// Create basic test structure
async function createTestStructure(projectName) {
  const testDir = join(process.cwd(), 'tests');
  const e2eDir = join(testDir, 'e2e');

  await fs.mkdir(e2eDir, { recursive: true });

  // Create playwright.config.ts
  const playwrightConfig = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list']
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
`;

  // Create example test
  const exampleTest = `import { test, expect } from '@playwright/test';

test.describe('${projectName} E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('homepage loads successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/.*/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('page is responsive', async ({ page }) => {
    // Desktop
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator('body')).toBeVisible();

    // Tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('body')).toBeVisible();

    // Mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(errors).toHaveLength(0);
  });

  test('accessibility basics', async ({ page }) => {
    // Check for basic accessibility attributes
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', /.+/);

    // Check for skip link or main landmark
    const main = page.locator('main, [role="main"]');
    await expect(main).toBeVisible();
  });
});
`;

  // Create auth test template
  const authTest = `import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test.skip('login with valid credentials', async ({ page }) => {
    // TODO: Implement login test
    await page.goto('/login');

    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'testpassword');
    await page.click('[type="submit"]');

    await expect(page).toHaveURL('/dashboard');
  });

  test.skip('logout successfully', async ({ page }) => {
    // TODO: Implement logout test
    await page.goto('/dashboard');
    await page.click('[data-testid="logout-button"]');

    await expect(page).toHaveURL('/login');
  });

  test.skip('protected route redirects to login', async ({ page }) => {
    // TODO: Implement protected route test
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\\/login/);
  });
});
`;

  // Create API test template
  const apiTest = `import { test, expect } from '@playwright/test';

test.describe('API Endpoints', () => {
  const baseURL = process.env.BASE_URL || 'http://localhost:3000';

  test.skip('health check endpoint', async ({ request }) => {
    const response = await request.get(\`\${baseURL}/api/health\`);

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test.skip('API returns proper error format', async ({ request }) => {
    const response = await request.get(\`\${baseURL}/api/nonexistent\`);

    expect(response.status()).toBe(404);
    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
`;

  // Create performance test template
  const perfTest = `import { test, expect } from '@playwright/test';

test.describe('Performance Tests', () => {
  test('page load performance', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const loadTime = Date.now() - startTime;

    // Page should load within 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });

  test('no large layout shifts', async ({ page }) => {
    await page.goto('/');

    // Wait for page to stabilize
    await page.waitForTimeout(2000);

    const cls = await page.evaluate(() => {
      return new Promise((resolve) => {
        let clsValue = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // @ts-ignore
            clsValue += entry.value;
          }
        });
        observer.observe({ type: 'layout-shift', buffered: true });

        setTimeout(() => {
          observer.disconnect();
          resolve(clsValue);
        }, 1000);
      });
    });

    // CLS should be less than 0.1 for good UX
    expect(cls).toBeLessThan(0.1);
  });
});
`;

  await fs.writeFile(join(process.cwd(), 'playwright.config.ts'), playwrightConfig);
  await fs.writeFile(join(e2eDir, 'homepage.spec.ts'), exampleTest);
  await fs.writeFile(join(e2eDir, 'auth.spec.ts'), authTest);
  await fs.writeFile(join(e2eDir, 'api.spec.ts'), apiTest);
  await fs.writeFile(join(e2eDir, 'performance.spec.ts'), perfTest);

  return testDir;
}

// Run tests
async function runTests(options) {
  const args = ['playwright', 'test'];

  if (options.headed) args.push('--headed');
  if (options.debug) args.push('--debug');
  if (options.ui) args.push('--ui');
  if (options.project) args.push('--project', options.project);
  if (options.grep) args.push('--grep', options.grep);
  if (options.reporter) args.push('--reporter', options.reporter);
  if (options.workers) args.push('--workers', options.workers);
  if (options.retries) args.push('--retries', options.retries);

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', args, {
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    proc.on('error', reject);
  });
}

// Generate test report
async function generateReport() {
  try {
    execSync('npx playwright show-report', { stdio: 'inherit' });
  } catch (error) {
    console.log(chalk.yellow('No test report found. Run tests first.'));
  }
}

// Run tests on staging server
async function runStagingTests(projectName, options) {
  const stagingUrl = `https://${projectName}-staging.codeb.dev`;

  console.log(chalk.cyan(`\n🌐 Running tests against staging: ${stagingUrl}\n`));

  process.env.BASE_URL = stagingUrl;

  const args = ['playwright', 'test', '--project=chromium'];

  if (options.headed) args.push('--headed');
  if (options.grep) args.push('--grep', options.grep);

  return new Promise((resolve) => {
    const proc = spawn('npx', args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, BASE_URL: stagingUrl }
    });

    proc.on('close', (code) => resolve(code === 0));
  });
}

// Main test command
export const testCommand = new Command('test')
  .description('Run E2E tests with Playwright')
  .argument('[action]', 'Action: run, init, report, staging, ci')
  .option('--headed', 'Run tests in headed mode')
  .option('--debug', 'Run in debug mode')
  .option('--ui', 'Open Playwright UI mode')
  .option('-p, --project <name>', 'Run specific project (chromium, firefox, webkit)')
  .option('-g, --grep <pattern>', 'Only run tests matching pattern')
  .option('--reporter <type>', 'Reporter type (list, html, json)')
  .option('-w, --workers <count>', 'Number of parallel workers')
  .option('-r, --retries <count>', 'Number of retries for failed tests')
  .option('--staging', 'Run tests against staging environment')
  .option('--production', 'Run tests against production environment')
  .option('--project-name <name>', 'Project name for staging/production tests')
  .action(async (action = 'run', options) => {
    const spinner = ora();

    try {
      // Determine project name
      let projectName = options.projectName;
      if (!projectName) {
        try {
          const pkg = JSON.parse(await fs.readFile(join(process.cwd(), 'package.json'), 'utf-8'));
          projectName = pkg.name;
        } catch {
          projectName = 'my-project';
        }
      }

      console.log(chalk.cyan(`\n🧪 we-cli test - E2E Testing for ${projectName}\n`));

      switch (action) {
        case 'init': {
          // Initialize test structure
          spinner.start('Checking Playwright installation...');
          const hasPlaywright = await checkPlaywright();

          if (!hasPlaywright) {
            spinner.warn('Playwright not found');
            await installPlaywright();
          } else {
            spinner.succeed('Playwright is installed');
          }

          spinner.start('Creating test structure...');
          const testDir = await createTestStructure(projectName);
          spinner.succeed(`Test structure created at ${testDir}`);

          // Update package.json scripts
          try {
            const pkgPath = join(process.cwd(), 'package.json');
            const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

            pkg.scripts = pkg.scripts || {};
            pkg.scripts['test'] = 'playwright test';
            pkg.scripts['test:headed'] = 'playwright test --headed';
            pkg.scripts['test:ui'] = 'playwright test --ui';
            pkg.scripts['test:debug'] = 'playwright test --debug';
            pkg.scripts['test:report'] = 'playwright show-report';

            await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
            console.log(chalk.green('\n✅ Updated package.json with test scripts'));
          } catch (error) {
            console.log(chalk.yellow('\n⚠️  Could not update package.json'));
          }

          console.log(chalk.white('\n📄 Created Files:'));
          console.log(chalk.gray('   • playwright.config.ts'));
          console.log(chalk.gray('   • tests/e2e/homepage.spec.ts'));
          console.log(chalk.gray('   • tests/e2e/auth.spec.ts'));
          console.log(chalk.gray('   • tests/e2e/api.spec.ts'));
          console.log(chalk.gray('   • tests/e2e/performance.spec.ts'));

          console.log(chalk.yellow('\n📋 Next Steps:'));
          console.log(chalk.gray('   1. Review and customize test files'));
          console.log(chalk.gray('   2. Run: /we:test run'));
          console.log(chalk.gray('   3. View report: /we:test report'));
          break;
        }

        case 'run': {
          // Check for test files
          const testDir = await checkTestDir();
          if (!testDir) {
            console.log(chalk.yellow('No test directory found. Run /we:test init first.'));
            process.exit(1);
          }

          console.log(chalk.white(`📂 Running tests from ${testDir}/\n`));

          if (options.staging) {
            await runStagingTests(projectName, options);
          } else if (options.production) {
            process.env.BASE_URL = `https://${projectName}.codeb.dev`;
            await runTests(options);
          } else {
            const success = await runTests(options);

            if (success) {
              console.log(chalk.green('\n✅ All tests passed!'));
            } else {
              console.log(chalk.red('\n❌ Some tests failed'));
              console.log(chalk.gray('   Run /we:test report to view details'));
            }
          }
          break;
        }

        case 'report': {
          console.log(chalk.white('📊 Opening test report...\n'));
          await generateReport();
          break;
        }

        case 'staging': {
          const testDir = await checkTestDir();
          if (!testDir) {
            console.log(chalk.yellow('No test directory found. Run /we:test init first.'));
            process.exit(1);
          }

          const success = await runStagingTests(projectName, options);

          if (success) {
            console.log(chalk.green('\n✅ Staging tests passed!'));
          } else {
            console.log(chalk.red('\n❌ Staging tests failed'));
          }
          break;
        }

        case 'ci': {
          // CI mode - run all tests with JSON reporter
          console.log(chalk.white('🔄 Running tests in CI mode...\n'));

          const args = ['playwright', 'test', '--reporter=json,github'];

          const success = await new Promise((resolve) => {
            const proc = spawn('npx', args, {
              stdio: 'inherit',
              shell: true
            });
            proc.on('close', (code) => resolve(code === 0));
          });

          process.exit(success ? 0 : 1);
        }

        default: {
          // Default to run
          const testDir = await checkTestDir();
          if (!testDir) {
            // No tests, offer to initialize
            const { shouldInit } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'shouldInit',
                message: 'No tests found. Initialize test structure?',
                default: true
              }
            ]);

            if (shouldInit) {
              await testCommand.parseAsync(['node', 'test', 'init']);
            }
          } else {
            await runTests(options);
          }
        }
      }

    } catch (error) {
      spinner.fail('Test operation failed');
      console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

export default testCommand;
