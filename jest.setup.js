import 'whatwg-fetch'
import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

// `asyncUtilTimeout` defaults to 1000 ms, which a `waitFor` or `findBy`
// blows whenever several jest workers contend for this machine's four
// CPUs -- two suites were being called flaky for exactly that reason while
// each passed every run in isolation. Raising it cannot mask a real
// failure: a broken assertion still fails, only later.
configure({ testIdAttribute: 'data-test', asyncUtilTimeout: 5000 })

// Jest's own per-test default is also 5000 ms, so an `asyncUtilTimeout` of
// 5000 would let a failing `waitFor` blow the test timeout before it could
// report what it was waiting for -- a clear assertion failure turns into
// "Exceeded timeout of 5000 ms", which is exactly the wrong message to get
// when a test breaks. Give the test itself room above the utility timeout.
jest.setTimeout(20000)
