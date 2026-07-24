import { describe, expect, it } from 'vitest'
import { deriveCpaReadiness } from './init'

describe('deriveCpaReadiness', () => {
  it('derives each readiness surface independently while liveness gates access', () => {
    expect(
      deriveCpaReadiness({
        alive: true,
        modelsReady: true,
        managementReady: false,
        routingLinked: true
      })
    ).toEqual({
      alive: true,
      modelsReady: true,
      managementReady: false,
      routingLinked: true
    })
    expect(
      deriveCpaReadiness({
        alive: false,
        modelsReady: true,
        managementReady: true,
        routingLinked: true
      })
    ).toEqual({
      alive: false,
      modelsReady: false,
      managementReady: false,
      routingLinked: false
    })
  })

  it('treats ready-with-zero-backends as models-ready when the models request succeeded', () => {
    expect(
      deriveCpaReadiness({
        alive: true,
        modelsReady: true,
        managementReady: true,
        routingLinked: false
      })
    ).toMatchObject({ alive: true, modelsReady: true, managementReady: true })
  })
})
