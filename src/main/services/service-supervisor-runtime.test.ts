import { describe, expect, it } from 'vitest'
import { windowsTaskkillArgs } from './service-supervisor-runtime'

describe('service supervisor process runtime', () => {
  it('hard-kills the complete Windows process tree per D7', () => {
    expect(windowsTaskkillArgs(4242)).toEqual(['/pid', '4242', '/T', '/F'])
  })
})
