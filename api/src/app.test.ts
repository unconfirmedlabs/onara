import { describe, expect, test } from 'bun:test'
import app from './app'

describe('HTTP surface', () => {
  test('does not expose policy configuration', async () => {
    const response = await app.request('/policies')

    expect(response.status).toBe(404)
  })
})
