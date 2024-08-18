/* eslint-disable import/order */
jest.mock('child_process');
import { bockfs } from '@aws-cdk/cdk-build-tools';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import * as cdk from 'aws-cdk-lib';
import * as semver from 'semver';
import * as sinon from 'sinon';
import { ImportMock } from 'ts-mock-imports';
import { execProgram } from '../../lib/api/cxapp/exec';
import { LogLevel, setLogLevel } from '../../lib/logging';
import { Configuration } from '../../lib/settings';
import { testAssembly } from '../util';
import { mockSpawn } from '../util/mock-child_process';
import { MockSdkProvider } from '../util/mock-sdk';

let sdkProvider: MockSdkProvider;
let config: Configuration;
beforeEach(() => {
  setLogLevel(LogLevel.DEBUG);

  sdkProvider = new MockSdkProvider();
  config = new Configuration();

  config.settings.set(['output'], 'cdk.out');

  // insert contents in fake filesystem
  bockfs({
    '/home/project/cloud-executable': 'ARBITRARY',
    '/home/project/windows.js': 'ARBITRARY',
    'home/project/executable-app.js': 'ARBITRARY',
  });
  bockfs.workingDirectory('/home/project');
  bockfs.executable('/home/project/cloud-executable');
  bockfs.executable('/home/project/executable-app.js');
});

afterEach(() => {
  setLogLevel(LogLevel.DEFAULT);

  sinon.restore();
  bockfs.restore();
});

// We need to increase the default 5s jest
// timeout for async tests because the 'execProgram' invocation
// might take a while :\
const TEN_SECOND_TIMEOUT = 10000;

function createApp(): cdk.App {
  const app = new cdk.App({ outdir: 'cdk.out' });
  const stack = new cdk.Stack(app, 'Stack');

  new cdk.CfnResource(stack, 'Role', {
    type: 'AWS::IAM::Role',
    properties: {
      RoleName: 'Role',
    },
  });

  return app;
}

test('cli throws when manifest version > schema version', async () => {

  const app = createApp();
  const currentSchemaVersion = cxschema.Manifest.version();
  const mockManifestVersion = semver.inc(currentSchemaVersion, 'major');

  // this mock will cause the framework to use a greater schema version than the real one,
  // and should cause the CLI to fail.
  const mockVersionNumber = ImportMock.mockFunction(cxschema.Manifest, 'version', mockManifestVersion);
  try {
    app.synth();
  } finally {
    mockVersionNumber.restore();
  }

  const expectedError = 'This CDK CLI is not compatible with the CDK library used by your application. Please upgrade the CLI to the latest version.'
    + `\n(Cloud assembly schema version mismatch: Maximum schema version supported is ${semver.major(currentSchemaVersion)}.x.x, but found ${mockManifestVersion})`;

  config.settings.set(['app'], 'cdk.out');

  await expect(execProgram(sdkProvider, config)).rejects.toEqual(new Error(expectedError));

}, TEN_SECOND_TIMEOUT);

test('cli does not throw when manifest version = schema version', async () => {

  const app = createApp();
  app.synth();

  config.settings.set(['app'], 'cdk.out');

  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();

}, TEN_SECOND_TIMEOUT);

test('cli does not throw when manifest version < schema version', async () => {

  const app = createApp();
  const currentSchemaVersion = cxschema.Manifest.version();

  app.synth();

  config.settings.set(['app'], 'cdk.out');

  // this mock will cause the cli to think its exepcted schema version is
  // greater that the version created in the manifest, which is what we are testing for.
  const mockVersionNumber = ImportMock.mockFunction(cxschema.Manifest, 'version', semver.inc(currentSchemaVersion, 'major'));
  try {
    const { lock } = await execProgram(sdkProvider, config);
    await lock.release();
  } finally {
    mockVersionNumber.restore();
  }

}, TEN_SECOND_TIMEOUT);

test('validates --app key is present', async () => {
  // GIVEN no config key for `app`
  await expect(execProgram(sdkProvider, config)).rejects.toThrow(
    '--app is required either in command-line, in cdk.json or in ~/.cdk.json',
  );

});

test('bypasses synth when app points to a cloud assembly', async () => {
  // GIVEN
  config.settings.set(['app'], 'cdk.out');
  writeOutputAssembly();

  // WHEN
  const { assembly: cloudAssembly, lock } = await execProgram(sdkProvider, config);
  expect(cloudAssembly.artifacts).toEqual([]);
  expect(cloudAssembly.directory).toEqual('cdk.out');

  await lock.release();
});

test('the application set in --app is executed', async () => {
  // GIVEN
  config.settings.set(['app'], 'cloud-executable');
  mockSpawn({
    commandLine: 'cloud-executable',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
});

test('the application set in --app is executed as-is if it contains a filename that does not exist', async () => {
  // GIVEN
  config.settings.set(['app'], 'does-not-exist');
  mockSpawn({
    commandLine: 'does-not-exist',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
});

test('the application set in --app is executed with arguments', async () => {
  // GIVEN
  config.settings.set(['app'], 'cloud-executable an-arg');
  mockSpawn({
    commandLine: 'cloud-executable an-arg',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
});

test('application set in --app as `*.js` always uses handler on windows', async () => {
  // GIVEN
  sinon.stub(process, 'platform').value('win32');
  config.settings.set(['app'], 'windows.js');
  mockSpawn({
    commandLine: process.execPath + ' windows.js',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
});

test('application set in --app is `*.js` and executable', async () => {
  // GIVEN
  config.settings.set(['app'], 'executable-app.js');
  mockSpawn({
    commandLine: 'executable-app.js',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
});

test('cli throws when the `build` script fails', async () => {
  // GIVEN
  config.settings.set(['build'], 'fake-command');
  mockSpawn({
    commandLine: 'fake-command',
    exitCode: 127,
  });

  // WHEN
  await expect(execProgram(sdkProvider, config)).rejects.toEqual(new Error('Subprocess exited with error 127'));
}, TEN_SECOND_TIMEOUT);

test('cli does not throw when the `build` script succeeds', async () => {
  // GIVEN
  config.settings.set(['build'], 'real command');
  config.settings.set(['app'], 'executable-app.js');
  mockSpawn({
    commandLine: 'real command', // `build` key is not split on whitespace
    exitCode: 0,
  },
  {
    commandLine: 'executable-app.js',
    sideEffect: () => writeOutputAssembly(),
  });

  // WHEN
  const { lock } = await execProgram(sdkProvider, config);
  await lock.release();
}, TEN_SECOND_TIMEOUT);

function writeOutputAssembly() {
  const asm = testAssembly({
    stacks: [],
  });
  bockfs.write('/home/project/cdk.out/manifest.json', JSON.stringify(asm.manifest));
}
