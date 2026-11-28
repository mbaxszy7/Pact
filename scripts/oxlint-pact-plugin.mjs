/**
 * Project-specific Oxlint rules enforcing Pact architecture invariants:
 * - pact/no-async-transaction-callback: better-sqlite3 / Drizzle transactions are synchronous;
 *   an async callback commits on the first await and leaks subsequent writes outside the txn.
 * - pact/no-real-time-wait-in-deterministic-tests: deterministic FSM/interleaving test suites
 *   must use injected clocks/schedulers rather than real-time timers.
 */

function isAsyncFunctionNode(node) {
  return (
    node != null &&
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    node.async === true
  )
}

function getCalleePropertyName(callee) {
  if (!callee) return undefined
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier'
  ) {
    return callee.property.name
  }
  if (callee.type === 'ChainExpression') {
    return getCalleePropertyName(callee.expression)
  }
  return undefined
}

const noAsyncTransactionCallback = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow async callbacks in synchronous SQLite/Drizzle .transaction() calls.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (getCalleePropertyName(node.callee) !== 'transaction') return
        const firstArg = node.arguments?.[0]
        if (!isAsyncFunctionNode(firstArg)) return
        context.report({
          node: firstArg,
          message:
            'Synchronous better-sqlite3/Drizzle transaction() callbacks must not be async; the first await commits the transaction prematurely.',
        })
      },
    }
  },
}

const noRealTimeWaitInDeterministicTests = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow setTimeout/setInterval in deterministic state-machine test suites.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        const name = callee?.type === 'Identifier' ? callee.name : getCalleePropertyName(callee)
        if (name !== 'setTimeout' && name !== 'setInterval') return
        context.report({
          node,
          message:
            'Deterministic test suites must use injected clocks or synchronous schedulers instead of real-time timers.',
        })
      },
    }
  },
}

const pactPlugin = {
  meta: {
    name: 'pact',
  },
  rules: {
    'no-async-transaction-callback': noAsyncTransactionCallback,
    'no-real-time-wait-in-deterministic-tests': noRealTimeWaitInDeterministicTests,
  },
}

export default pactPlugin
