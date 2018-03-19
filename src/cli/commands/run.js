/* @flow */

import type {Reporter} from '../../reporters/index.js';
import type Config from '../../config.js';
import {execCommand, makeEnv} from '../../util/execute-lifecycle-script.js';
import {dynamicRequire} from '../../util/dynamic-require.js';
import {MessageError} from '../../errors.js';
import {registries} from '../../resolvers/index.js';
import * as fs from '../../util/fs.js';
import * as constants from '../../constants.js';

const invariant = require('invariant');
const leven = require('leven');
const path = require('path');
const {quoteForShell, sh, unquoted} = require('puka');

function toObject(input: Map<string, string>): Object {
  const output = Object.create(null);

  for (const [key, val] of input.entries()) {
    output[key] = val;
  }

  return output;
}

export function setFlags(commander: Object) {
  commander.description('Runs a defined package script.');
}

export function hasWrapper(commander: Object, args: Array<string>): boolean {
  return true;
}

export async function run(config: Config, reporter: Reporter, flags: Object, args: Array<string>): Promise<void> {
  const pkg = await config.readManifest(config.cwd);

  const binFolders = new Set();
  // Setup the node_modules/.bin folders for analysis
  for (const registry of Object.keys(registries)) {
    binFolders.add(path.join(config.cwd, config.registries[registry].folder, '.bin'));
  }

  // Same thing, but for the pnp dependencies, located inside the cache
  if (await fs.exists(`${config.lockfileFolder}/${constants.PNP_FILENAME}`)) {
    const pnpApi = dynamicRequire(`${config.lockfileFolder}/${constants.PNP_FILENAME}`);
    const topLevelInformation = pnpApi.getPackageInformation({name: null, reference: null});

    for (const [name, reference] of topLevelInformation.packageDependencies.entries()) {
      const dependencyInformation = pnpApi.getPackageInformation({name, reference});

      if (dependencyInformation.packageLocation) {
        binFolders.add(`${dependencyInformation.packageLocation}/.bin`);
      }
    }
  }

  const binCommands = new Set();
  const pkgCommands = new Set();

  const scripts: Map<string, string> = new Map();

  // Build up a list of possible scripts by exploring the folders marked for analysis
  for (const binFolder of binFolders) {
    if (await fs.exists(binFolder)) {
      for (const name of await fs.readdir(binFolder)) {
        scripts.set(name, quoteForShell(path.join(binFolder, name)));
        binCommands.add(name);
      }
    }
  }

  const pkgScripts = pkg.scripts;

  if (pkgScripts) {
    for (const name of Object.keys(pkgScripts).sort()) {
      scripts.set(name, pkgScripts[name] || '');
      pkgCommands.add(name);
    }
  }

  async function runCommand(args): Promise<void> {
    const action = args.shift();

    // build up list of commands
    const cmds = [];

    if (pkgScripts && action in pkgScripts) {
      const preAction = `pre${action}`;
      if (preAction in pkgScripts) {
        cmds.push([preAction, pkgScripts[preAction]]);
      }

      const script = scripts.get(action);
      invariant(script, 'Script must exist');
      cmds.push([action, script]);

      const postAction = `post${action}`;
      if (postAction in pkgScripts) {
        cmds.push([postAction, pkgScripts[postAction]]);
      }
    } else if (scripts.has(action)) {
      const script = scripts.get(action);
      invariant(script, 'Script must exist');
      cmds.push([action, script]);
    }

    if (cmds.length) {
      // Disable wrapper in executed commands
      process.env.YARN_WRAP_OUTPUT = 'false';
      for (const [stage, cmd] of cmds) {
        // only tack on trailing arguments for default script, ignore for pre and post - #1595
        const cmdWithArgs = stage === action ? sh`${unquoted(cmd)} ${args}` : cmd;
        const customShell = config.getOption('script-shell');
        if (customShell) {
          await execCommand(stage, config, cmdWithArgs, config.cwd, String(customShell));
        } else {
          await execCommand(stage, config, cmdWithArgs, config.cwd);
        }
      }
    } else if (action === 'env') {
      reporter.log(JSON.stringify(await makeEnv('env', config.cwd, config), null, 2), {force: true});
    } else {
      let suggestion;

      for (const commandName in scripts) {
        const steps = leven(commandName, action);
        if (steps < 2) {
          suggestion = commandName;
        }
      }

      let msg = `Command ${JSON.stringify(action)} not found.`;
      if (suggestion) {
        msg += ` Did you mean ${JSON.stringify(suggestion)}?`;
      }
      throw new MessageError(msg);
    }
  }

  // list possible scripts if none specified
  if (args.length === 0) {
    reporter.error(reporter.lang('commandNotSpecified'));

    if (binCommands.size > 0) {
      reporter.info(`${reporter.lang('binCommands') + Array.from(binCommands).join(', ')}`);
    } else {
      reporter.error(reporter.lang('noBinAvailable'));
    }

    const printedCommands: Map<string, string> = new Map();

    for (const pkgCommand of pkgCommands) {
      const action = scripts.get(pkgCommand);
      invariant(action, 'Action must exists');
      printedCommands.set(pkgCommand, action);
    }

    if (pkgCommands.size > 0) {
      reporter.info(`${reporter.lang('possibleCommands')}`);
      reporter.list('possibleCommands', Array.from(pkgCommands), toObject(printedCommands));
      await reporter
        .question(reporter.lang('commandQuestion'))
        .then(answer => runCommand(answer.split(' ')), () => reporter.error(reporter.lang('commandNotSpecified')));
    } else {
      reporter.error(reporter.lang('noScriptsAvailable'));
    }
    return Promise.resolve();
  } else {
    return runCommand(args);
  }
}
