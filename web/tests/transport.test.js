import assert from 'node:assert/strict'
import test from 'node:test'

import {
  availableTransportSeats,
  parseTransportPoints,
  validateTransportAssignment,
  validateTransportRoute,
} from '../src/transport.js'

const validRoute = {
  route_number: 'R-12',
  bus_number: 'BUS-12',
  registration_number: 'TEST-REG-12',
  pickup_points: 'North Gate, Library',
  drop_points: 'Campus',
  driver_name: 'Synthetic Driver',
  driver_phone: '+1 555 123 4567',
  capacity: '40',
}

test('transport route form validates and parses route details', () => {
  assert.equal(validateTransportRoute(validRoute), '')
  assert.deepEqual(parseTransportPoints(' North Gate, Library '), ['North Gate', 'Library'])
})

test('transport route form rejects invalid identifiers, stops, driver and capacity', () => {
  assert.match(validateTransportRoute({ ...validRoute, route_number: 'R 12' }), /Route number/)
  assert.match(validateTransportRoute({ ...validRoute, pickup_points: 'Library, library' }), /unique pickup/)
  assert.match(validateTransportRoute({ ...validRoute, driver_phone: '123' }), /Driver phone/)
  assert.match(validateTransportRoute({ ...validRoute, capacity: '2.5' }), /whole number/)
  assert.equal(parseTransportPoints(''), null)
})

test('student assignment requires a valid ID and both selected route points', () => {
  assert.equal(validateTransportAssignment({
    student_id: 'STU-1',
    pickup_point: 'North Gate',
    drop_point: 'Campus',
  }), '')
  assert.match(validateTransportAssignment({
    student_id: 'bad id',
    pickup_point: 'North Gate',
    drop_point: 'Campus',
  }), /student ID/)
})

test('available seats never underflow', () => {
  assert.equal(availableTransportSeats({ capacity: 40, assigned_seats: 12 }), 28)
  assert.equal(availableTransportSeats({ capacity: 5, assigned_seats: 8 }), 0)
})
