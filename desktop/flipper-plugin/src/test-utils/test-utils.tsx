/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import * as React from 'react';
import {
  render,
  RenderResult,
  act as testingLibAct,
} from '@testing-library/react';
import {queries} from '@testing-library/dom';
import {PluginDetails} from 'flipper-plugin-lib';

import {
  RealFlipperClient,
  SandyPluginInstance,
  PluginClient,
} from '../plugin/Plugin';
import {
  SandyPluginDefinition,
  FlipperPluginModule,
  FlipperDevicePluginModule,
} from '../plugin/SandyPluginDefinition';
import {SandyPluginRenderer} from '../plugin/PluginRenderer';
import {act} from '@testing-library/react';
import {
  DeviceLogEntry,
  SandyDevicePluginInstance,
  RealFlipperDevice,
  DeviceLogListener,
} from '../plugin/DevicePlugin';
import {BasePluginInstance} from '../plugin/PluginBase';
import {FlipperLib} from '../plugin/FlipperLib';

type Renderer = RenderResult<typeof queries>;

interface StartPluginOptions {
  initialState?: Record<string, any>;
  isArchived?: boolean;
  isBackgroundPlugin?: boolean;
  startUnactivated?: boolean;
  /** Provide a set of unsupported methods to simulate older clients that don't support certain methods yet */
  unsupportedMethods?: string[];
  /**
   * Provide a set of GKs that are enabled in this test.
   */
  GKs?: string[];
}

type ExtractClientType<Module extends FlipperPluginModule<any>> = Parameters<
  Module['plugin']
>[0];

type ExtractMethodsType<
  Module extends FlipperPluginModule<any>
> = ExtractClientType<Module> extends PluginClient<any, infer Methods>
  ? Methods
  : never;

type ExtractEventsType<
  Module extends FlipperPluginModule<any>
> = ExtractClientType<Module> extends PluginClient<infer Events, any>
  ? Events
  : never;

interface BasePluginResult {
  /**
   * Mock for Flipper utilities
   */
  flipperLib: FlipperLib;

  /**
   * Emulates the 'onActivate' event
   */
  activate(): void;
  /**
   * Emulates the 'onActivate' event (when the user opens the plugin in the UI).
   * Will also trigger the `onConnect` event for non-background plugins
   */
  deactivate(): void;
  /**
   * Emulates the 'destroy' event. After calling destroy this plugin instance won't be usable anymore
   */
  destroy(): void;

  /**
   * Emulate triggering a deeplink
   */
  triggerDeepLink(deeplink: unknown): void;

  /**
   * Grab all the persistable state
   */
  exportState(): any;

  /**
   * Trigger menu entry by label
   */
  triggerMenuEntry(label: string): void;
}

interface StartPluginResult<Module extends FlipperPluginModule<any>>
  extends BasePluginResult {
  /**
   * the instantiated plugin for this test
   */
  instance: ReturnType<Module['plugin']>;
  /**
   * module, from which any other exposed methods can be accessed during testing
   */
  module: Module;
  /**
   * Emulates the 'onConnect' event
   */
  connect(): void;
  /**
   * Emulatese the 'onDisconnect' event
   */
  disconnect(): void;
  /**
   * Jest Stub that is called whenever client.send() is called by the plugin.
   * Use send.mockImplementation(function) to intercept the calls.
   */
  onSend: jest.MockedFunction<
    <Method extends keyof ExtractMethodsType<Module>>(
      method: Method,
      params: Parameters<ExtractMethodsType<Module>[Method]>[0],
    ) => ReturnType<ExtractMethodsType<Module>[Method]>
  >;
  /**
   * Send event to the plugin
   */
  sendEvent<Event extends keyof ExtractEventsType<Module>>(
    event: Event,
    params: ExtractEventsType<Module>[Event],
  ): void;
  /**
   * Send events to the plugin
   * The structure used here reflects events that can be recorded
   * with the pluginRecorder
   */
  sendEvents(
    events: {
      method: keyof ExtractEventsType<Module>;
      params: any; // afaik we can't type this :-(
    }[],
  ): void;
}

interface StartDevicePluginResult<Module extends FlipperDevicePluginModule>
  extends BasePluginResult {
  /**
   * the instantiated plugin for this test
   */
  instance: ReturnType<Module['devicePlugin']>;
  /**
   * module, from which any other exposed methods can be accessed during testing
   */
  module: Module;
  /**
   * Emulates sending a log message arriving from the device
   */
  sendLogEntry(logEntry: DeviceLogEntry): void;
}

export function startPlugin<Module extends FlipperPluginModule<any>>(
  module: Module,
  options?: StartPluginOptions,
): StartPluginResult<Module> {
  const definition = new SandyPluginDefinition(
    createMockPluginDetails(),
    module,
  );
  if (definition.isDevicePlugin) {
    throw new Error(
      'Use `startDevicePlugin` or `renderDevicePlugin` to test device plugins',
    );
  }

  const sendStub = jest.fn();
  const flipperUtils = createMockFlipperLib(options);
  const testDevice = createMockDevice(options);
  const appName = 'TestApplication';
  const deviceName = 'TestDevice';
  const fakeFlipperClient: RealFlipperClient = {
    id: `${appName}#${testDevice.os}#${deviceName}#${testDevice.serial}`,
    query: {
      app: appName,
      device: deviceName,
      device_id: testDevice.serial,
      os: testDevice.serial,
    },
    deviceSync: testDevice,
    isBackgroundPlugin(_pluginId: string) {
      return !!options?.isBackgroundPlugin;
    },
    initPlugin() {
      pluginInstance.connect();
    },
    deinitPlugin() {
      pluginInstance.disconnect();
    },
    call(
      _api: string,
      method: string,
      _fromPlugin: boolean,
      params?: Object,
    ): Promise<Object> {
      return sendStub(method, params);
    },
    async supportsMethod(_api: string, method: string) {
      return !options?.unsupportedMethods?.includes(method);
    },
  };

  const pluginInstance = new SandyPluginInstance(
    flipperUtils,
    definition,
    fakeFlipperClient,
    options?.initialState,
  );

  const res: StartPluginResult<Module> = {
    ...createBasePluginResult(pluginInstance),
    instance: pluginInstance.instanceApi,
    module,
    connect: () => pluginInstance.connect(),
    disconnect: () => pluginInstance.disconnect(),
    onSend: sendStub,
    sendEvent: (event, params) => {
      res.sendEvents([
        {
          method: event,
          params,
        },
      ]);
    },
    sendEvents: (messages) => {
      act(() => {
        pluginInstance.receiveMessages(messages as any);
      });
    },
  };
  (res as any)._backingInstance = pluginInstance;
  // we start activated
  if (options?.isBackgroundPlugin) {
    pluginInstance.connect(); // otherwise part of activate
  }
  if (!options?.startUnactivated) {
    pluginInstance.activate();
  }
  return res;
}

export function renderPlugin<Module extends FlipperPluginModule<any>>(
  module: Module,
  options?: StartPluginOptions,
): StartPluginResult<Module> & {
  renderer: Renderer;
  act: (cb: () => void) => void;
} {
  const res = startPlugin(module, options);
  const pluginInstance: SandyPluginInstance = (res as any)._backingInstance;

  const renderer = render(<SandyPluginRenderer plugin={pluginInstance} />);

  return {
    ...res,
    renderer,
    act: testingLibAct,
    destroy: () => {
      renderer.unmount();
      pluginInstance.destroy();
    },
  };
}

export function startDevicePlugin<Module extends FlipperDevicePluginModule>(
  module: Module,
  options?: StartPluginOptions,
): StartDevicePluginResult<Module> {
  const definition = new SandyPluginDefinition(
    createMockPluginDetails(),
    module,
  );
  if (!definition.isDevicePlugin) {
    throw new Error(
      'Use `startPlugin` or `renderPlugin` to test non-device plugins',
    );
  }

  const flipperLib = createMockFlipperLib(options);
  const testDevice = createMockDevice(options);
  const pluginInstance = new SandyDevicePluginInstance(
    flipperLib,
    definition,
    testDevice,
    options?.initialState,
  );

  const res: StartDevicePluginResult<Module> = {
    ...createBasePluginResult(pluginInstance),
    module,
    instance: pluginInstance.instanceApi,
    sendLogEntry: (entry) => {
      act(() => {
        testDevice.addLogEntry(entry);
      });
    },
  };
  (res as any)._backingInstance = pluginInstance;
  // we start connected
  pluginInstance.activate();
  return res;
}

export function renderDevicePlugin<Module extends FlipperDevicePluginModule>(
  module: Module,
  options?: StartPluginOptions,
): StartDevicePluginResult<Module> & {
  renderer: Renderer;
  act: (cb: () => void) => void;
} {
  const res = startDevicePlugin(module, options);
  // @ts-ignore hidden api
  const pluginInstance: SandyDevicePluginInstance = (res as any)
    ._backingInstance;

  const renderer = render(<SandyPluginRenderer plugin={pluginInstance} />);

  return {
    ...res,
    renderer,
    act: testingLibAct,
    destroy: () => {
      renderer.unmount();
      pluginInstance.destroy();
    },
  };
}

export function createMockFlipperLib(options?: StartPluginOptions): FlipperLib {
  return {
    enableMenuEntries: jest.fn(),
    createPaste: jest.fn(),
    GK(gk: string) {
      return options?.GKs?.includes(gk) || false;
    },
  };
}

function createBasePluginResult(
  pluginInstance: BasePluginInstance,
): BasePluginResult {
  return {
    flipperLib: pluginInstance.flipperLib,
    activate: () => pluginInstance.activate(),
    deactivate: () => pluginInstance.deactivate(),
    exportState: () => pluginInstance.exportState(),
    triggerDeepLink: (deepLink: unknown) => {
      pluginInstance.triggerDeepLink(deepLink);
    },
    destroy: () => pluginInstance.destroy(),
    triggerMenuEntry: (action: string) => {
      const entry = pluginInstance.menuEntries.find((e) => e.action === action);
      if (!entry) {
        throw new Error('No menu entry found with action: ' + action);
      }
      entry.handler();
    },
  };
}

export function createMockPluginDetails(
  details?: Partial<PluginDetails>,
): PluginDetails {
  return {
    id: 'TestPlugin',
    dir: '',
    name: 'TestPlugin',
    specVersion: 0,
    entry: '',
    isDefault: false,
    main: '',
    source: '',
    title: 'Testing Plugin',
    version: '',
    ...details,
  };
}

function createMockDevice(options?: StartPluginOptions): RealFlipperDevice {
  const logListeners: (undefined | DeviceLogListener)[] = [];
  return {
    os: 'Android',
    deviceType: 'emulator',
    serial: 'serial-000',
    isArchived: !!options?.isArchived,
    addLogListener(cb) {
      logListeners.push(cb);
      return (logListeners.length - 1) as any;
    },
    removeLogListener(idx) {
      logListeners[idx as any] = undefined;
    },
    addLogEntry(entry: DeviceLogEntry) {
      logListeners.forEach((f) => f?.(entry));
    },
  };
}
