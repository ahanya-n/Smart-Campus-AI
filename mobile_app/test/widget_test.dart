import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:smart_campus_app/app.dart';
import 'package:smart_campus_app/app_scope.dart';
import 'package:smart_campus_app/config/api_config.dart';
import 'package:smart_campus_app/models/timetable.dart';
import 'package:smart_campus_app/screens/attendance_screen.dart';
import 'package:smart_campus_app/screens/campus_assistant_screen.dart';
import 'package:smart_campus_app/screens/complaints_screen.dart';
import 'package:smart_campus_app/screens/notifications_screen.dart';
import 'package:smart_campus_app/screens/library_screen.dart';
import 'package:smart_campus_app/screens/profile_screen.dart';
import 'package:smart_campus_app/screens/timetable_screen.dart';
import 'package:smart_campus_app/screens/transport_screen.dart';
import 'package:smart_campus_app/services/api_service.dart';
import 'package:smart_campus_app/services/auth_controller.dart';
import 'package:smart_campus_app/services/token_storage.dart';

/// In-memory token storage so tests never touch real secure storage.
class FakeTokenStorage implements TokenStorage {
  FakeTokenStorage([this.token]);

  String? token;

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> saveToken(String value) async => token = value;

  @override
  Future<void> clearToken() async => token = null;
}

const _fakeToken = 'test-token';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

/// Fake backend that mimics the FastAPI endpoints.
MockClient _fakeBackend({
  List<Map<String, dynamic>>? students,
  List<Map<String, dynamic>>? complaintsSeed,
  String userRole = 'student',
}) {
  String? linkedStudentId;
  final complaints = [
    for (final complaint in complaintsSeed ?? const <Map<String, dynamic>>[])
      Map<String, dynamic>.from(complaint),
  ];
  final libraryBook = <String, dynamic>{
    'id': '0123456789abcdef01234567',
    'title': 'The Pragmatic Programmer',
    'author': 'Andrew Hunt',
    'isbn': '9780135957059',
    'category': 'Software',
    'total_copies': 2,
    'available_copies': 2,
  };
  final libraryLoans = <Map<String, dynamic>>[];
  final transportRoute = <String, dynamic>{
    'id': '1234567890abcdef12345678',
    'route_number': 'TEST-1',
    'bus_number': 'SYNTHETIC-BUS',
    'registration_number': 'TEST-REG',
    'pickup_points': ['Test Gate'],
    'drop_points': ['Test Campus'],
    'driver': {'name': 'Synthetic Test Driver', 'phone': '+1 555 123 4567'},
    'capacity': 40,
    'assigned_seats': 0,
    'available_seats': 40,
  };
  return MockClient((request) async {
    final path = request.url.path;
    final auth = request.headers['Authorization'];

    if (request.method == 'POST' && path == '/login') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      if (body['email'] == 'asha@example.com' &&
          body['password'] == 'secret123') {
        return _json({'access_token': _fakeToken, 'token_type': 'bearer'});
      }
      return _json({'detail': 'Incorrect email or password'}, 401);
    }
    if (request.method == 'POST' && path == '/register') {
      return _json({'detail': 'Email already registered'}, 400);
    }
    if (request.method == 'GET' && path == '/me') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Invalid token'}, 401);
      }
      return _json({
        'name': 'Asha Rao',
        'email': 'asha@example.com',
        'role': userRole,
        'student_id': ?linkedStudentId,
      });
    }
    if (request.method == 'POST' && path == '/me/link-student') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      linkedStudentId = body['student_id'] as String?;
      return _json({
        'name': 'Asha Rao',
        'email': 'asha@example.com',
        'role': 'student',
        'student_id': linkedStudentId,
      });
    }
    if (request.method == 'GET' && path == '/students') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json(
        students ??
            [
              {
                'student_id': 'MCA001',
                'name': 'Naveen',
                'email': 'naveen@example.com',
                'department': 'MCA',
                'semester': 1,
              },
            ],
      );
    }
    if (path == '/complaints') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      if (request.method == 'GET') {
        return _json({'items': complaints, 'total': complaints.length});
      }
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        final complaint = <String, dynamic>{
          'id': 'complaint-${complaints.length + 1}',
          'category': body['category'],
          'title': body['title'],
          'description': body['description'],
          'status': 'pending',
          'created_at': DateTime.utc(2025).toIso8601String(),
          'assigned_staff_name': null,
          'resolution_notes': null,
          'responses': [],
        };
        complaints.add(complaint);
        return _json(complaint, 201);
      }
    }
    if (path.startsWith('/library/')) {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      if (request.method == 'GET' && path == '/library/books') {
        final search =
            request.url.queryParameters['search']?.toLowerCase() ?? '';
        final matches = [libraryBook].where(
          (book) =>
              search.isEmpty ||
              ['title', 'author', 'isbn', 'category'].any(
                (field) =>
                    book[field].toString().toLowerCase().contains(search),
              ),
        );
        return _json(matches.toList());
      }
      if (request.method == 'GET' && path == '/library/loans') {
        return _json(libraryLoans);
      }
      if (request.method == 'POST' &&
          path == '/library/books/${libraryBook['id']}/borrow') {
        if (libraryBook['available_copies'] == 0) {
          return _json({'detail': 'This book is currently unavailable'}, 409);
        }
        libraryBook['available_copies'] =
            (libraryBook['available_copies'] as int) - 1;
        final now = DateTime.now().toUtc();
        final loan = <String, dynamic>{
          'id': 'fedcba9876543210fedcba98',
          'book_id': libraryBook['id'],
          'book_title': libraryBook['title'],
          'book_isbn': libraryBook['isbn'],
          'status': 'borrowed',
          'borrowed_at': now.toIso8601String(),
          'due_at': now.add(const Duration(days: 14)).toIso8601String(),
          'returned_at': null,
        };
        libraryLoans.add(loan);
        return _json(loan, 201);
      }
      if (request.method == 'POST' &&
          path == '/library/loans/fedcba9876543210fedcba98/return') {
        final index = libraryLoans.indexWhere(
          (loan) => loan['status'] == 'borrowed',
        );
        if (index < 0) {
          return _json({'detail': 'Active loan not found'}, 404);
        }
        libraryLoans[index]['status'] = 'returned';
        libraryLoans[index]['returned_at'] = DateTime.now()
            .toUtc()
            .toIso8601String();
        libraryBook['available_copies'] =
            (libraryBook['available_copies'] as int) + 1;
        return _json(libraryLoans[index]);
      }
    }
    if (path.startsWith('/transport/')) {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      if (request.method == 'GET' && path == '/transport/routes') {
        return _json([
          {
            ...transportRoute,
            if (userRole == 'admin')
              'assignments': [
                {
                  'student_id': 'SYNTHETIC-STUDENT',
                  'pickup_point': 'Test Gate',
                  'drop_point': 'Test Campus',
                },
              ],
          },
        ]);
      }
      if (request.method == 'GET' && path == '/transport/me') {
        return _json({'assigned': false, 'route': null, 'assignment': null});
      }
    }
    final demo = request.url.queryParameters['demo'] == 'true';
    if (request.method == 'GET' && path == '/attendance/me') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json(demo ? _demoAttendance : _unlinkedAttendance);
    }
    if (request.method == 'GET' && path == '/timetable') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json(demo ? _demoTimetable : _unlinkedTimetable);
    }
    if (request.method == 'POST' && path == '/assistant/chat') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final msg = (body['message'] ?? '').toString();
      if (msg.contains('attendance')) {
        return _json({
          'reply': 'Your overall attendance is 77.6% (59/76 classes attended).',
          'intent': 'attendance',
          'provider': 'grounded_rule_engine',
          'day': 'Monday',
          'data_summary': {
            'linked': true,
            'student_name': 'Naveen',
            'overall_attendance': 77.6,
            'low_attendance_count': 1,
            'total_classes_day': 2,
          },
          'suggestions': [
            'What is my attendance percentage?',
            'When is my next class?',
            'When am I free today?',
          ],
        });
      }
      return _json({
        'reply': 'You have 90 mins of free time between classes on Monday (10:00 - 11:30).',
        'intent': 'free_time',
        'provider': 'grounded_rule_engine',
        'day': 'Monday',
        'data_summary': {
          'linked': true,
          'student_name': 'Naveen',
          'overall_attendance': 77.6,
          'low_attendance_count': 1,
          'total_classes_day': 2,
        },
        'suggestions': [
          'What is my attendance percentage?',
          'When is my next class?',
        ],
      });
    }
    if (request.method == 'GET' && path == '/assistant/free-time') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({
        'day': 'Monday',
        'linked': true,
        'total_classes': 2,
        'busy_slots': [
          {
            'start_time': '09:00',
            'end_time': '10:00',
            'duration_minutes': 60,
            'duration_display': '1 hr',
          },
          {
            'start_time': '11:30',
            'end_time': '13:00',
            'duration_minutes': 90,
            'duration_display': '1 hr 30 mins',
          },
        ],
        'free_slots': [
          {
            'start_time': '10:00',
            'end_time': '11:30',
            'duration_minutes': 90,
            'duration_display': '1 hr 30 mins',
            'slot_label': '10:00 - 11:30',
          },
        ],
        'total_free_minutes': 90,
        'total_free_display': '1 hr 30 mins',
        'best_slot': {
          'start_time': '10:00',
          'end_time': '11:30',
          'duration_minutes': 90,
          'duration_display': '1 hr 30 mins',
          'slot_label': '10:00 - 11:30',
        },
        'message':
            'You have 1 hr 30 mins of free time between classes on Monday.',
      });
    }
    if (request.method == 'GET' && path == '/notifications') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({
        'linked': true,
        'student_id': 'MCA001',
        'unread_count': 1,
        'notifications': [
          {
            'id': 'notif1',
            'student_id': 'MCA001',
            'subject_code': 'MCA403',
            'subject_name': 'Cloud Computing',
            'attendance_percentage': 72.22,
            'threshold': 75.0,
            'week_id': '2026-W42',
            'warning_type': 'low_attendance',
            'title': 'Low Attendance Warning: MCA403',
            'message': 'Your attendance in Cloud Computing (MCA403) is 72.22%, which is below the 75.0% threshold.',
            'reporting_date': '2026-10-14',
            'created_at': '2026-10-14T00:00:00Z',
            'is_read': false,
          },
        ],
      });
    }
    if (request.method == 'PATCH' && path == '/notifications/notif1/read') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({'message': 'Notification marked as read', 'id': 'notif1'});
    }
    return _json({'detail': 'Not Found'}, 404);
  });
}

const _notLinked = 'Your account is not linked to a student record.';
const _student = {
  'student_id': 'MCA001',
  'name': 'Naveen',
  'department': 'MCA',
  'semester': '1',
};

const _unlinkedAttendance = {
  'linked': false,
  'is_demo': false,
  'message': _notLinked,
  'student': null,
  'summary': {
    'total_classes': 0,
    'present_classes': 0,
    'absent_classes': 0,
    'attendance_percentage': 0.0,
    'subject_count': 0,
    'low_attendance_subjects': [],
    'threshold': 75.0,
  },
  'records': [],
};

const _demoAttendance = {
  'linked': false,
  'is_demo': true,
  'message':
      'DEMO DATA: sample records for demonstration, not official attendance.',
  'student': _student,
  'summary': {
    'total_classes': 76,
    'present_classes': 59,
    'absent_classes': 17,
    'attendance_percentage': 77.63,
    'subject_count': 2,
    'low_attendance_subjects': ['Cloud Computing'],
    'threshold': 75.0,
  },
  'records': [
    {
      'student_id': 'MCA001',
      'subject_code': 'MCA401',
      'subject_name': 'Advanced Java Programming',
      'total_classes': 40,
      'present_classes': 33,
      'absent_classes': 7,
      'attendance_percentage': 82.5,
      'low_attendance': false,
      'is_demo': true,
      'updated_at': '2026-10-11T10:00:00Z',
    },
    {
      'student_id': 'MCA001',
      'subject_code': 'MCA403',
      'subject_name': 'Cloud Computing',
      'total_classes': 36,
      'present_classes': 26,
      'absent_classes': 10,
      'attendance_percentage': 72.22,
      'low_attendance': true,
      'is_demo': true,
      'updated_at': '2026-10-11T10:00:00Z',
    },
  ],
};

const _unlinkedTimetable = {
  'linked': false,
  'is_demo': false,
  'message': _notLinked,
  'student': null,
  'day': null,
  'entries': [],
};

const _demoTimetable = {
  'linked': false,
  'is_demo': true,
  'message': 'DEMO DATA: sample timetable for demonstration, not the official schedule.',
  'student': _student,
  'day': null,
  'entries': [
    {
      'day_of_week': 'Monday',
      'subject_code': 'MCA402',
      'subject_name': 'Machine Learning',
      'start_time': '10:00',
      'end_time': '11:00',
      'faculty_name': 'Prof. Karthik Menon',
      'room_number': 'MCA-202',
      'is_demo': true,
    },
    {
      'day_of_week': 'Monday',
      'subject_code': 'MCA401',
      'subject_name': 'Advanced Java Programming',
      'start_time': '09:00',
      'end_time': '10:00',
      'faculty_name': 'Dr. Ananya Rao',
      'room_number': 'MCA-201',
      'is_demo': true,
    },
    {
      'day_of_week': 'Tuesday',
      'subject_code': 'MCA406',
      'subject_name': 'Data Science Lab',
      'start_time': '13:30',
      'end_time': '15:30',
      'faculty_name': 'Prof. Karthik Menon',
      'room_number': 'Lab-3',
      'is_demo': true,
    },
  ],
};

void main() {
  group('ApiService', () {
    test('uses the USB-reversed host URL by default', () {
      expect(ApiConfig.baseUrl, 'http://127.0.0.1:8000');
    });

    test('login returns the access token', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      final token = await api.login(
        email: 'asha@example.com',
        password: 'secret123',
      );
      expect(token, _fakeToken);
    });

    test('login shows the backend error message', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      expect(
        () => api.login(email: 'asha@example.com', password: 'wrong'),
        throwsA(
          isA<ApiException>()
              .having(
                (e) => e.message,
                'message',
                'Incorrect email or password',
              )
              .having((e) => e.statusCode, 'statusCode', 401),
        ),
      );
    });

    test('register shows the backend error message', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      expect(
        () => api.register(name: 'A', email: 'a@b.co', password: 'secret123'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'Email already registered',
          ),
        ),
      );
    });

    test('GET /me sends the Bearer token', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: _fakeBackend(),
      );
      final user = await api.getCurrentUser();
      expect(user.name, 'Asha Rao');
      expect(user.role, 'student');
    });

    test('GET /me without a token fails with 401', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      expect(
        () => api.getCurrentUser(),
        throwsA(
          isA<ApiException>().having(
            (e) => e.isUnauthorized,
            'isUnauthorized',
            true,
          ),
        ),
      );
    });

    test('GET /students parses student records', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: _fakeBackend(),
      );
      final students = await api.getStudents();
      expect(students, hasLength(1));
      expect(students.first.studentId, 'MCA001');
      expect(students.first.semester, '1');
    });

    test('GET /students without a token fails with 401', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      expect(
        () => api.getStudents(),
        throwsA(
          isA<ApiException>().having(
            (e) => e.isUnauthorized,
            'isUnauthorized',
            true,
          ),
        ),
      );
    });

    test(
      'POST /me/link-student sends an authenticated one-time link request',
      () async {
        http.Request? captured;
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            captured = request;
            return _json({
              'name': 'Asha Rao',
              'email': 'asha@example.com',
              'role': 'student',
              'student_id': 'MCA001',
            });
          }),
        );

        final user = await api.linkMyStudent(
          studentId: ' MCA001 ',
          linkCode: 'ABCD2345XY',
        );

        expect(captured?.method, 'POST');
        expect(captured?.url.path, '/me/link-student');
        expect(captured?.headers['Authorization'], 'Bearer $_fakeToken');
        expect(jsonDecode(captured!.body), {
          'student_id': ' MCA001 ',
          'link_code': 'ABCD2345XY',
        });
        expect(user.studentId, 'MCA001');
      },
    );

    test('FastAPI validation errors are readable', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: MockClient(
          (_) async => _json({
            'detail': [
              {
                'loc': ['body', 'email'],
                'msg': 'Field required',
                'type': 'missing',
              },
            ],
          }, 422),
        ),
      );
      expect(
        () => api.login(email: '', password: ''),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'email: Field required',
          ),
        ),
      );
    });

    test('connection failure gives a friendly message', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: MockClient((_) async => throw http.ClientException('refused')),
      );
      expect(
        () => api.getStudents(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.isNetworkError, 'isNetworkError', true)
              .having(
                (e) => e.message,
                'message',
                contains("Can't reach the server"),
              ),
        ),
      );
    });
  });

  group('Attendance & timetable API', () {
    test('getAttendance(demo) parses records and summary', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: _fakeBackend(),
      );
      final report = await api.getAttendance(demo: true);
      expect(report.isDemo, isTrue);
      expect(report.records, hasLength(2));
      expect(report.summary.percentage, 77.63);
      expect(report.summary.lowAttendanceSubjects, ['Cloud Computing']);
      expect(report.records.last.lowAttendance, isTrue);
    });

    test('getAttendance for an unlinked account returns no records', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: _fakeBackend(),
      );
      final report = await api.getAttendance();
      expect(report.linked, isFalse);
      expect(report.records, isEmpty);
    });

    test('getTimetable sorts a day by start time', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: _fakeBackend(),
      );
      final data = await api.getTimetable(demo: true);
      expect(data.entriesFor('Monday').map((e) => e.startTime), [
        '09:00',
        '10:00',
      ]);
      expect(data.entriesFor('Saturday'), isEmpty);
    });

    test('attendance requires sign-in', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      expect(
        () => api.getAttendance(),
        throwsA(
          isA<ApiException>().having(
            (e) => e.isUnauthorized,
            'isUnauthorized',
            true,
          ),
        ),
      );
    });

    test('defaultTimetableDay uses Monday on Sunday', () {
      expect(defaultTimetableDay(DateTime(2026, 10, 11)), 'Monday'); // Sunday
      expect(defaultTimetableDay(DateTime(2026, 10, 14)), 'Wednesday');
    });
  });

  group('Library API', () {
    test('searches and parses the authenticated book catalog', () async {
      http.Request? captured;
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: MockClient((request) async {
          captured = request;
          return _json([
            {
              'id': '0123456789abcdef01234567',
              'title': 'The Pragmatic Programmer',
              'author': 'Andrew Hunt',
              'isbn': '9780135957059',
              'category': 'Software',
              'total_copies': 2,
              'available_copies': 1,
            },
          ]);
        }),
      );

      final books = await api.getLibraryBooks(search: 'C++ & design');
      expect(captured?.url.path, '/library/books');
      expect(captured?.url.queryParameters['search'], 'C++ & design');
      expect(books.single.title, 'The Pragmatic Programmer');
      expect(books.single.availableCopies, 1);
    });

    test('borrows and returns books through authenticated endpoints', () async {
      final requests = <http.Request>[];
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: MockClient((request) async {
          requests.add(request);
          final now = DateTime.now().toUtc();
          return _json(
            {
              'id': 'fedcba9876543210fedcba98',
              'book_id': '0123456789abcdef01234567',
              'book_title': 'The Pragmatic Programmer',
              'book_isbn': '9780135957059',
              'status': 'borrowed',
              'borrowed_at': now.toIso8601String(),
              'due_at': now.add(const Duration(days: 14)).toIso8601String(),
              'returned_at': null,
            },
            request.method == 'POST' && request.url.path.endsWith('/borrow')
                ? 201
                : 200,
          );
        }),
      );

      final loan = await api.borrowLibraryBook('0123456789abcdef01234567');
      await api.returnLibraryBook(loan.id);
      expect(loan.status, 'borrowed');
      expect(requests.map((request) => request.url.path), [
        '/library/books/0123456789abcdef01234567/borrow',
        '/library/loans/fedcba9876543210fedcba98/return',
      ]);
      expect(
        requests.every(
          (request) =>
              request.headers['Authorization']?.startsWith('Bearer ') == true &&
              request.headers['Authorization']!.length > 'Bearer '.length,
        ),
        isTrue,
      );
    });

    test('library requests require a signed-in user', () async {
      final api = ApiService(
        tokenStorage: FakeTokenStorage(),
        client: _fakeBackend(),
      );
      await expectLater(
        api.getLibraryBooks(),
        throwsA(
          isA<ApiException>().having(
            (error) => error.isUnauthorized,
            'unauthorized',
            true,
          ),
        ),
      );
    });
  });

  group('Attendance & timetable screens', () {
    Widget wrap(Widget screen) {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(tokenStorage: storage, client: _fakeBackend());
      return AppScope(
        api: api,
        auth: AuthController(api: api, tokenStorage: storage),
        child: MaterialApp(home: screen),
      );
    }

    testWidgets('attendance: unlinked account can open labelled demo data', (
      tester,
    ) async {
      await tester.pumpWidget(wrap(const AttendanceScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Account not linked'), findsOneWidget);
      await tester.tap(find.text('View demo data'));
      await tester.pumpAndSettle();

      expect(find.text('DEMO DATA'), findsOneWidget);
      expect(find.text('Demo Data'), findsOneWidget);
      expect(find.byKey(const Key('overall_percentage')), findsOneWidget);
      expect(find.text('77.6%'), findsOneWidget);
      expect(find.text('Low attendance'), findsOneWidget);
      expect(find.text('76'), findsOneWidget); // total classes
      expect(find.text('Advanced Java Programming'), findsOneWidget);

      await tester.scrollUntilVisible(find.text('Cloud Computing'), 200);
      expect(find.text('Cloud Computing'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.close_rounded));
      await tester.pumpAndSettle();
      expect(find.text('Account not linked'), findsOneWidget);
    });

    testWidgets('timetable: demo data, day selector and class details', (
      tester,
    ) async {
      await tester.pumpWidget(
        wrap(const TimetableScreen(initialDay: 'Monday')),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('View demo data'));
      await tester.pumpAndSettle();

      expect(find.text('DEMO DATA'), findsOneWidget);
      expect(find.text('2 classes'), findsOneWidget);
      expect(find.text('Advanced Java Programming'), findsOneWidget);
      expect(find.text('Dr. Ananya Rao'), findsOneWidget);
      expect(find.text('Room MCA-201'), findsOneWidget);
      expect(find.text('09:00'), findsOneWidget);

      await tester.tap(find.byKey(const Key('day_Tue')));
      await tester.pumpAndSettle();
      expect(find.text('Data Science Lab'), findsOneWidget);
      expect(find.text('Room Lab-3'), findsOneWidget);

      await tester.tap(find.byKey(const Key('day_Sat')));
      await tester.pumpAndSettle();
      expect(find.text('There are no classes on Saturday.'), findsOneWidget);
    });

    testWidgets('dashboard tiles open the live screens', (tester) async {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(tokenStorage: storage, client: _fakeBackend());
      await tester.pumpWidget(
        SmartCampusApp(
          api: api,
          auth: AuthController(api: api, tokenStorage: storage),
        ),
      );
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Attendance'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Attendance'));
      await tester.pumpAndSettle();
      expect(find.text('Account not linked'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Timetable'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Timetable'));
      await tester.pumpAndSettle();
      expect(find.text('Account not linked'), findsOneWidget);
    });
  });

  group('Library screen', () {
    Widget wrap() {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(tokenStorage: storage, client: _fakeBackend());
      return AppScope(
        api: api,
        auth: AuthController(api: api, tokenStorage: storage),
        child: const MaterialApp(home: LibraryScreen()),
      );
    }

    testWidgets('catalog borrowing and returns update the borrowing history', (
      tester,
    ) async {
      await tester.pumpWidget(wrap());
      await tester.pumpAndSettle();

      expect(find.text('Available books'), findsOneWidget);
      expect(find.text('The Pragmatic Programmer'), findsOneWidget);
      expect(find.text('2 of 2 copies available'), findsOneWidget);

      await tester.tap(find.text('Borrow'));
      await tester.pumpAndSettle();
      expect(find.text('Borrowing history'), findsOneWidget);
      expect(find.text('The Pragmatic Programmer'), findsNWidgets(2));
      expect(find.text('1 of 2 copies available'), findsOneWidget);
      expect(find.text('Return'), findsOneWidget);

      await tester.tap(find.text('Return'));
      await tester.pumpAndSettle();
      expect(find.text('1 of 2 copies available'), findsNothing);
      expect(find.text('2 of 2 copies available'), findsOneWidget);
      expect(find.textContaining('Returned '), findsOneWidget);
    });
  });

  group('Complaints screen', () {
    Widget wrap({List<Map<String, dynamic>>? complaints}) {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(complaintsSeed: complaints),
      );
      return AppScope(
        api: api,
        auth: AuthController(api: api, tokenStorage: storage),
        child: const MaterialApp(home: ComplaintsScreen()),
      );
    }

    test('API parses history and returns a newly submitted complaint', () async {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(
          complaintsSeed: [
            {
              'id': 'complaint-synthetic-1',
              'category': 'facilities',
              'title': 'Broken classroom light',
              'description': 'The light in room B12 is not working.',
              'status': 'resolved',
              'created_at': '2025-01-01T00:00:00Z',
              'responses': [],
            },
          ],
        ),
      );

      expect((await api.getComplaints()).single.status, 'resolved');
      final created = await api.createComplaint(
        category: 'academic',
        title: 'Schedule question',
        description: 'Please clarify the published schedule.',
      );
      expect(created.title, 'Schedule question');
      expect(created.status, 'pending');
    });

    testWidgets('empty state, validation and complaint submission work', (
      tester,
    ) async {
      await tester.pumpWidget(wrap());
      await tester.pumpAndSettle();

      expect(
        find.text('You have not submitted any complaints.'),
        findsOneWidget,
      );
      await tester.tap(find.text('New complaint'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Facilities').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();

      expect(
        find.text('Enter a title between 3 and 120 characters.'),
        findsOneWidget,
      );
      expect(
        find.text('Enter a description between 10 and 5000 characters.'),
        findsOneWidget,
      );

      await tester.enterText(find.byType(TextFormField).at(0), 'Broken light');
      await tester.enterText(
        find.byType(TextFormField).at(1),
        'The light in room B12 is not working.',
      );
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();

      expect(find.text('Broken light'), findsOneWidget);
      expect(find.text('Facilities · Pending'), findsOneWidget);
    });

    testWidgets('history shows status, staff response and resolution notes', (
      tester,
    ) async {
      await tester.pumpWidget(
        wrap(
          complaints: [
            {
              'id': 'complaint-synthetic-1',
              'category': 'facilities',
              'title': 'Broken classroom light',
              'description': 'The light in room B12 is not working.',
              'status': 'resolved',
              'created_at': '2025-01-01T00:00:00Z',
              'assigned_staff_name': 'Synthetic Campus Staff',
              'resolution_notes': 'The lamp was replaced.',
              'responses': [
                {
                  'id': 'response-synthetic-1',
                  'author_name': 'Synthetic Campus Staff',
                  'message': 'The repair has been completed.',
                  'resolution_notes': 'The lamp was replaced.',
                  'created_at': '2025-01-02T00:00:00Z',
                },
              ],
            },
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Facilities · Resolved'), findsOneWidget);
      await tester.tap(find.text('Broken classroom light'));
      await tester.pumpAndSettle();

      expect(find.text('Synthetic Campus Staff'), findsWidgets);
      expect(find.textContaining('The repair has been completed.'), findsOneWidget);
      expect(find.text('Resolution notes: The lamp was replaced.'), findsOneWidget);
    });
  });

  group('Transport screen', () {
    test(
      'transport API parses routes and the signed-in student response',
      () async {
        final storage = FakeTokenStorage(_fakeToken);
        final requests = <http.Request>[];
        final api = ApiService(
          tokenStorage: storage,
          client: MockClient((request) async {
            requests.add(request);
            if (request.url.path == '/transport/routes') {
              return _json([
                {
                  'id': '1234567890abcdef12345678',
                  'route_number': 'TEST-1',
                  'bus_number': 'SYNTHETIC-BUS',
                  'registration_number': 'TEST-REG',
                  'pickup_points': ['Test Gate'],
                  'drop_points': ['Test Campus'],
                  'driver': {'name': 'Synthetic Test Driver'},
                  'capacity': 40,
                  'assigned_seats': 0,
                  'available_seats': 40,
                },
              ]);
            }
            return _json({
              'assigned': true,
              'route': {
                'id': '1234567890abcdef12345678',
                'route_number': 'TEST-1',
                'bus_number': 'SYNTHETIC-BUS',
                'registration_number': 'TEST-REG',
                'pickup_points': ['Test Gate'],
                'drop_points': ['Test Campus'],
                'driver': {'name': 'Synthetic Test Driver'},
                'capacity': 40,
                'assigned_seats': 1,
                'available_seats': 39,
              },
              'assignment': {
                'student_id': 'TEST-STUDENT',
                'pickup_point': 'Test Gate',
                'drop_point': 'Test Campus',
              },
            });
          }),
        );

        final routes = await api.getTransportRoutes();
        final details = await api.getMyTransport();

        expect(routes.single.busNumber, 'SYNTHETIC-BUS');
        expect(routes.single.availableSeats, 40);
        expect(details.assigned, isTrue);
        expect(details.assignment?.pickupPoint, 'Test Gate');
        expect(details.route?.driver.phone, isNull);
        expect(
          requests.every(
            (request) =>
                request.headers['Authorization'] == 'Bearer $_fakeToken',
          ),
          isTrue,
        );
      },
    );

    testWidgets(
      'dashboard lists synthetic routes and empty student assignment',
      (tester) async {
        final storage = FakeTokenStorage(_fakeToken);
        final api = ApiService(tokenStorage: storage, client: _fakeBackend());
        final auth = AuthController(api: api, tokenStorage: storage);
        await auth.restoreSession();
        expect(auth.user?.isStudent, isTrue);

        await tester.pumpWidget(
          AppScope(
            api: api,
            auth: auth,
            child: const MaterialApp(home: TransportScreen()),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Transport dashboard'), findsOneWidget);
        expect(find.text('My transport'), findsOneWidget);
        expect(
          find.text('No transport assignment is recorded for your account.'),
          findsOneWidget,
        );
        expect(find.textContaining('TEST-1'), findsOneWidget);
        expect(find.textContaining('40 of 40 seats available'), findsOneWidget);

        await tester.tap(find.textContaining('TEST-1'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Synthetic Test Driver'), findsOneWidget);
        expect(find.textContaining('Test Gate'), findsOneWidget);
      },
    );

    testWidgets('administrators see route management and private details', (
      tester,
    ) async {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(userRole: 'admin'),
      );
      final auth = AuthController(api: api, tokenStorage: storage);
      await auth.restoreSession();

      await tester.pumpWidget(
        AppScope(
          api: api,
          auth: auth,
          child: const MaterialApp(home: TransportScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byTooltip('Add route'), findsOneWidget);
      expect(find.text('My transport'), findsNothing);
      await tester.tap(find.textContaining('TEST-1'));
      await tester.pumpAndSettle();
      expect(find.textContaining('+1 555 123 4567'), findsOneWidget);
      expect(find.text('SYNTHETIC-STUDENT'), findsOneWidget);
      expect(find.text('Assign student'), findsOneWidget);
    });
  });

  group('AuthController', () {
    test('login saves the token; logout clears it', () async {
      final storage = FakeTokenStorage();
      final api = ApiService(tokenStorage: storage, client: _fakeBackend());
      final auth = AuthController(api: api, tokenStorage: storage);

      await auth.login(email: 'asha@example.com', password: 'secret123');
      expect(auth.status, AuthStatus.authenticated);
      expect(storage.token, _fakeToken);
      expect(auth.user?.name, 'Asha Rao');

      await auth.logout();
      expect(auth.status, AuthStatus.unauthenticated);
      expect(storage.token, isNull);
      expect(auth.user, isNull);
    });

    test('restoreSession signs in with a valid saved token', () async {
      final storage = FakeTokenStorage(_fakeToken);
      final auth = AuthController(
        api: ApiService(tokenStorage: storage, client: _fakeBackend()),
        tokenStorage: storage,
      );

      await auth.restoreSession();
      expect(auth.status, AuthStatus.authenticated);
    });

    test('restoreSession clears an invalid saved token', () async {
      final storage = FakeTokenStorage('expired-token');
      final auth = AuthController(
        api: ApiService(tokenStorage: storage, client: _fakeBackend()),
        tokenStorage: storage,
      );

      await auth.restoreSession();
      expect(auth.status, AuthStatus.unauthenticated);
      expect(storage.token, isNull);
    });
  });

  group('App', () {
    Widget buildApp(
      FakeTokenStorage storage, {
      List<Map<String, dynamic>>? students,
    }) {
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(students: students),
      );
      return SmartCampusApp(
        api: api,
        auth: AuthController(api: api, tokenStorage: storage),
      );
    }

    testWidgets('shows the login screen when there is no saved session', (
      tester,
    ) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage()));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      expect(find.text('Welcome back'), findsOneWidget);
      expect(find.byKey(const Key('login_submit')), findsOneWidget);
    });

    testWidgets('login opens registration screen and validates fields', (
      tester,
    ) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage()));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Create one'));
      await tester.pumpAndSettle();

      expect(find.text('Create your account'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('register_submit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('register_submit')));
      await tester.pump();

      expect(find.text('Please enter your name'), findsOneWidget);
    });

    testWidgets('login form validates empty fields', (tester) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage()));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('login_submit')));
      await tester.pump();

      expect(find.text('Please enter your email'), findsOneWidget);
      expect(find.text('Please enter your password'), findsOneWidget);
    });

    testWidgets('wrong password shows the backend error', (tester) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage()));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('login_email')),
        'asha@example.com',
      );
      await tester.enterText(find.byKey(const Key('login_password')), 'wrong');
      await tester.tap(find.byKey(const Key('login_submit')));
      await tester.pumpAndSettle();

      expect(find.text('Incorrect email or password'), findsOneWidget);
    });

    testWidgets('login opens the dashboard and the student directory works', (
      tester,
    ) async {
      final storage = FakeTokenStorage();
      await tester.pumpWidget(buildApp(storage));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('login_email')),
        'asha@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('login_password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('login_submit')));
      await tester.pumpAndSettle();

      expect(storage.token, _fakeToken);
      expect(find.text('Welcome, Asha!'), findsOneWidget);

      await tester.tap(
        find.descendant(
          of: find.byType(NavigationBar),
          matching: find.text('Students'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Naveen'), findsOneWidget);
      expect(find.text('MCA001'), findsOneWidget);
      expect(find.text('Semester 1'), findsOneWidget);
    });

    testWidgets(
      'saved session opens the dashboard; sign out returns to login',
      (tester) async {
        final storage = FakeTokenStorage(_fakeToken);
        await tester.pumpWidget(buildApp(storage, students: []));
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpAndSettle();

        expect(find.text('Welcome, Asha!'), findsOneWidget);

        await tester.tap(
          find.descendant(
            of: find.byType(NavigationBar),
            matching: find.text('Students'),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('No students yet'), findsOneWidget);

        await tester.tap(
          find.descendant(
            of: find.byType(NavigationBar),
            matching: find.text('Profile'),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.byKey(const Key('logout_button')),
          200,
          scrollable: find
              .descendant(
                of: find.byType(ProfileScreen),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.ensureVisible(find.byKey(const Key('logout_button')));
        await tester.drag(
          find
              .descendant(
                of: find.byType(ProfileScreen),
                matching: find.byType(Scrollable),
              )
              .first,
          const Offset(0, -180),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('logout_button')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.widgetWithText(FilledButton, 'Sign out'),
          ),
        );
        await tester.pumpAndSettle();

        expect(storage.token, isNull);
        expect(find.text('Welcome back'), findsOneWidget);
      },
    );

    testWidgets('student can redeem a link code from Profile', (tester) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage()));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('login_email')),
        'asha@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('login_password')),
        'secret123',
      );
      await tester.tap(find.byKey(const Key('login_submit')));
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.byType(NavigationBar),
          matching: find.text('Profile'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ProfileScreen), findsOneWidget);
      final profileScroll = find
          .descendant(
            of: find.byType(ProfileScreen),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.byKey(const Key('student_link_id')),
        200,
        scrollable: profileScroll,
      );
      await tester.enterText(
        find.byKey(const Key('student_link_id')),
        'MCA001',
      );
      await tester.scrollUntilVisible(
        find.byKey(const Key('student_link_code')),
        200,
        scrollable: profileScroll,
      );
      await tester.enterText(
        find.byKey(const Key('student_link_code')),
        'ABCD2345XY',
      );
      await tester.scrollUntilVisible(
        find.byKey(const Key('student_link_submit')),
        200,
        scrollable: profileScroll,
      );
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('student_link_submit')));
      await tester.tap(find.byKey(const Key('student_link_submit')));
      await tester.pumpAndSettle();

      expect(find.text('Student ID'), findsOneWidget);
      expect(find.text('MCA001'), findsOneWidget);
      expect(find.byKey(const Key('student_link_submit')), findsNothing);
    });
  });

  group('AI Assistant, Free Time & Attendance Warnings', () {
    test('assistant API forwards recent conversation context', () async {
      Map<String, dynamic>? sentBody;
      final client = MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/assistant/chat');
        sentBody = jsonDecode(request.body) as Map<String, dynamic>;
        return _json({
          'reply': 'Your next class is taught by the assigned faculty.',
          'intent': 'faculty_details',
          'provider': 'grounded_rule_engine',
          'day': 'Monday',
          'data_summary': {
            'linked': true,
            'student_name': 'Synthetic Student',
            'overall_attendance': null,
            'low_attendance_count': 0,
            'total_classes_day': 0,
          },
          'suggestions': <String>[],
        });
      });
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: client,
      );
      final history = [
        {
          'role': 'assistant',
          'content': 'Your next class is Database Systems.',
          'intent': 'next_class',
        },
      ];

      final response = await api.askAssistant(
        'Who is taking it?',
        history: history,
      );

      expect(sentBody?['message'], 'Who is taking it?');
      expect(sentBody?['history'], history);
      expect(response['intent'], 'faculty_details');
    });

    Widget wrap(Widget screen) {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(tokenStorage: storage, client: _fakeBackend());
      return AppScope(
        api: api,
        auth: AuthController(api: api, tokenStorage: storage),
        child: MaterialApp(home: screen),
      );
    }

    testWidgets(
      'AI Assistant screen displays greeting, suggested questions and answers',
      (tester) async {
        await tester.pumpWidget(wrap(const CampusAssistantScreen()));
        await tester.pumpAndSettle();

        expect(find.text('AI Campus Assistant'), findsOneWidget);
        expect(find.text('What is my attendance percentage?'), findsOneWidget);
        expect(
          find.text('Which subjects have low attendance?'),
          findsOneWidget,
        );

        await tester.tap(find.text('What is my attendance percentage?'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pumpAndSettle();

        expect(find.textContaining('77.6%'), findsOneWidget);
        expect(find.text('ATTENDANCE'), findsOneWidget);
      },
    );

    testWidgets('AI Assistant asks for free time and displays free window', (
      tester,
    ) async {
      await tester.pumpWidget(wrap(const CampusAssistantScreen()));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'When am I free today?');
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(find.textContaining('90 mins of free time'), findsOneWidget);
      expect(find.text('FREE_TIME'), findsOneWidget);
    });

    testWidgets(
      'Notifications screen displays weekly low attendance warnings',
      (tester) async {
        await tester.pumpWidget(wrap(const NotificationsScreen()));
        await tester.pumpAndSettle();

        expect(find.text('Attendance Notices'), findsOneWidget);
        expect(find.text('Low Attendance Warning: MCA403'), findsOneWidget);
        expect(find.textContaining('72.22%'), findsNWidgets(2));
        expect(find.textContaining('Min: 75.0%'), findsOneWidget);
        expect(find.text('NEW'), findsOneWidget);

        await tester.tap(find.text('Low Attendance Warning: MCA403'));
        await tester.pumpAndSettle();
      },
    );
  });
}
