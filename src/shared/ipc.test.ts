import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ERROR_CODES,
  EVENT_CHANNELS,
  EXTERNAL_URL_PROTOCOLS,
  IPC,
  isEventChannel,
  SETTINGS_IPC,
  SHELL_MENU_IPC,
  STORE_NAMES
} from './ipc'

describe('IPC channel names', () => {
  it('names the request channels', () => {
    expect(IPC).toEqual({
      storage: { load: 'storage:load', save: 'storage:save', status: 'storage:status' },
      app: { quit: 'app:quit', openExternal: 'app:openExternal' },
      display: { get: 'display:get', list: 'display:list' },
      peek: {
        get: 'peek:get',
        inputFocus: 'peek:inputFocus',
        activity: 'peek:activity',
        clickOutside: 'peek:clickOutside',
        shortcutStatus: 'peek:shortcutStatus'
      },
      quickHide: { get: 'quickHide:get', set: 'quickHide:set' },
      desktop: {
        list: 'desktop:list',
        open: 'desktop:open',
        showInFolder: 'desktop:showInFolder',
        rename: 'desktop:rename',
        trash: 'desktop:trash',
        moveToDesktop: 'desktop:moveToDesktop',
        undoMove: 'desktop:undoMove',
        rescan: 'desktop:rescan',
        icons: 'desktop:icons'
      },
      theme: { get: 'theme:get' },
      wallpaper: { get: 'wallpaper:get' },
      dragOut: { start: 'desktop:startDrag', probe: 'desktop:cursorOverOtherWindow' }
    })
  })

  it('names the typed desktop error codes', () => {
    expect(DESKTOP_ERROR_CODES).toEqual([
      'not-found',
      'readonly',
      'exists',
      'permission',
      'busy',
      'name-too-long',
      'invalid-name',
      'hash-mismatch',
      'journal-read-only',
      'failed'
    ])
  })

  it('lists every main → renderer event', () => {
    expect([...EVENT_CHANNELS].sort()).toEqual(
      [
        'desktop:changed',
        'desktop:renamed',
        'desktop:icon',
        'storage:recovered',
        'storage:changed',
        'theme:changed',
        'peek:changed',
        'peek:shortcut',
        'quickHide:changed',
        'display:changed',
        'wallpaper:changed',
        'inspector:open'
      ].sort()
    )
  })

  it('recognises only listed events', () => {
    expect(isEventChannel('desktop:changed')).toBe(true)
    expect(isEventChannel('storage:load')).toBe(false)
    expect(isEventChannel('__proto__')).toBe(false)
    expect(isEventChannel(42)).toBe(false)
  })

  it('names the persisted renderer stores and the external URL allow-list', () => {
    expect(STORE_NAMES).toEqual(['settings', 'layout', 'tasks'])
    expect(EXTERNAL_URL_PROTOCOLS).toEqual(['ms-settings:', 'https:'])
  })

  it('names the native-menu channels (native menus, Phase 3)', () => {
    expect(SHELL_MENU_IPC).toEqual({
      show: 'shellMenu:show',
      available: 'shellMenu:available'
    })
  })

  it('names the Phase 11 settings inspector channels', () => {
    expect(SETTINGS_IPC).toEqual({
      peekHold: 'peek:hold',
      openDataFolder: 'app:openDataFolder',
      info: 'app:info'
    })
  })
})
