import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show TargetPlatform, debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
  List<Map<String, dynamic>>? conversationsSeed,
  List<Map<String, dynamic>>? studyDocumentsSeed,
  List<int>? conversationListStatuses,
  String userRole = 'student',
  void Function(http.Request request)? onAssistantChat,
  Map<String, dynamic> Function(http.Request request)? onPlacementResearch,
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
  final moodCheckIns = <Map<String, dynamic>>[];
  final studyDocuments = [
    for (final document in studyDocumentsSeed ?? const <Map<String, dynamic>>[])
      Map<String, dynamic>.from(document),
  ];
  final assistantConversations = [
    for (final conversation
        in conversationsSeed ?? const <Map<String, dynamic>>[])
      Map<String, dynamic>.from(conversation),
  ];
  final conversationStatuses = [...?conversationListStatuses];
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
    if (request.method == 'GET' && path == '/dashboard/me') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({
        'profile': {
          'name': 'Asha Rao',
          'email': 'asha@example.com',
          'student_id': 'MCA001',
          'roll_number': 'MCA001',
          'department': 'MCA',
          'course': 'MCA',
          'semester': 1,
          'section': 'A',
        },
        'attendance': {
          'percentage': 82.5,
          'present_classes': 33,
          'total_classes': 40,
          'subject_count': 5,
        },
        'cgpa': 8.25,
        'study_streak': 4,
        'timetable': {'today': 'Monday', 'entries': []},
        'marks': [],
        'assignments': {
          'total': 2,
          'pending': 2,
          'submitted': 0,
          'upcoming': [],
        },
        'notifications': [],
        'is_demo': false,
      });
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
    if (request.method == 'GET' && path == '/lost-found/my-reports') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({'items': <Map<String, dynamic>>[], 'total': 0});
    }
    if (path == '/assistant/conversations') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      if (request.method == 'GET') {
        if (conversationStatuses.isNotEmpty) {
          final status = conversationStatuses.removeAt(0);
          if (status != 200) {
            return _json({
              'detail': 'Conversation service unavailable',
            }, status);
          }
        }
        return _json(assistantConversations);
      }
      if (request.method == 'POST') {
        final id =
            'assistant-conversation-${assistantConversations.length + 1}';
        final conversation = <String, dynamic>{
          'id': id,
          'title': 'New conversation',
          'messages': <Map<String, dynamic>>[],
        };
        assistantConversations.insert(0, conversation);
        return _json(conversation);
      }
    }
    if (path.startsWith('/assistant/conversations/')) {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      final id = path.split('/').last;
      final index = assistantConversations.indexWhere(
        (conversation) => conversation['id'] == id,
      );
      if (index < 0) return _json({'detail': 'Conversation not found'}, 404);
      if (request.method == 'GET') return _json(assistantConversations[index]);
      if (request.method == 'DELETE') {
        assistantConversations.removeAt(index);
        return _json({'deleted': true, 'id': id});
      }
    }
    if (path == '/assistant/mood/check-ins') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      if (request.method == 'GET') return _json({'check_ins': moodCheckIns});
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        final checkIn = {
          'id': 'synthetic-mood-${moodCheckIns.length + 1}',
          'mood': body['mood'],
          'sentiment': body['mood'] == 'low' || body['mood'] == 'very_low'
              ? 'negative'
              : 'neutral',
          'score': body['mood'] == 'low'
              ? 2
              : body['mood'] == 'very_low'
              ? 1
              : 3,
          'created_at': DateTime.now().toUtc().toIso8601String(),
          if (body['reflection'] is String &&
              (body['reflection'] as String).trim().isNotEmpty)
            'reflection': (body['reflection'] as String).trim(),
          if (body['mood'] == 'low' || body['mood'] == 'very_low')
            'support_message': 'This check-in is not a diagnosis. Consider reaching out to someone you trust.',
        };
        moodCheckIns.insert(0, checkIn);
        return _json(checkIn, 201);
      }
    }
    if (request.method == 'GET' && path == '/assistant/mood/analytics') {
      if (auth != 'Bearer $_fakeToken' ||
          (userRole != 'admin' && userRole != 'faculty')) {
        return _json({'detail': 'Not authorized'}, 403);
      }
      return _json({
        'suppressed': false,
        'minimum_group_size': 5,
        'groups': <Map<String, dynamic>>[],
      });
    }
    if (path == '/assistant/study/documents') {
      if (auth != 'Bearer $_fakeToken' || userRole != 'student') {
        return _json({'detail': 'Not authorized'}, 403);
      }
      if (request.method == 'GET') return _json({'documents': studyDocuments});
      if (request.method == 'POST') {
        final document = <String, dynamic>{
          'id': 'study-document-${studyDocuments.length + 1}',
          'filename': 'study_material.txt',
          'summary': 'A private study document summary.',
          'word_count': 9,
        };
        studyDocuments.insert(0, document);
        return _json(document, 201);
      }
    }
    if (path.startsWith('/assistant/study/documents/')) {
      if (auth != 'Bearer $_fakeToken' || userRole != 'student') {
        return _json({'detail': 'Not authorized'}, 403);
      }
      if (request.method == 'DELETE') {
        final id = path.split('/')[4];
        studyDocuments.removeWhere((document) => document['id'] == id);
        return _json({'deleted': true, 'id': id});
      }
      if (request.method == 'POST' && path.endsWith('/quiz')) {
        return _json({
          'questions': [
            {'question': 'Complete the statement: ____', 'answer': 'local'},
          ],
        });
      }
      if (request.method == 'POST' && path.endsWith('/flashcards')) {
        return _json({
          'flashcards': [
            {'front': 'What is a tree?', 'back': 'A data structure.'},
          ],
        });
      }
    }
    if (request.method == 'POST' && path == '/assistant/placement/documents') {
      return _json({
        'id': 'private-resume-1',
        'filename': 'study_material.txt',
        'summary': 'Private resume content.',
      }, 201);
    }
    if (request.method == 'GET' && path == '/assistant/study/documents') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      return _json({'documents': <Map<String, dynamic>>[]});
    }
    if (request.method == 'POST' && path == '/assistant/placement/research') {
      final response = onPlacementResearch?.call(request);
      if (response != null) return _json(response);
      return _json({
        'available': false,
        'summary': null,
        'sources': <Map<String, dynamic>>[],
        'reason': 'Grounded web search is not available from the configured AI provider.',
      });
    }
    if (request.method == 'POST' && path == '/assistant/chat') {
      if (auth != 'Bearer $_fakeToken') {
        return _json({'detail': 'Not authenticated'}, 401);
      }
      onAssistantChat?.call(request);
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final conversationId =
          body['conversation_id']?.toString() ??
          'chat-conversation-${assistantConversations.length + 1}';
      if (!assistantConversations.any(
        (conversation) => conversation['id'] == conversationId,
      )) {
        assistantConversations.insert(0, {
          'id': conversationId,
          'title': body['message']?.toString() ?? 'Conversation',
          'messages': <Map<String, dynamic>>[],
        });
      }
      final msg = (body['message'] ?? '').toString();
      if (msg.contains('attendance')) {
        return _json({
          'reply': 'Your overall attendance is 77.6% (59/76 classes attended).',
          'intent': 'attendance',
          'provider': 'grounded_rule_engine',
          'conversation_id': conversationId,
          'mode': body['mode'] ?? 'general',
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
        'conversation_id': conversationId,
        'mode': body['mode'] ?? 'general',
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
    test('uses host loopback on Windows by default', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      expect(ApiConfig.baseUrl, 'http://127.0.0.1:8000');
    });

    test('uses host loopback by default on Android for USB reverse', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      expect(ApiConfig.baseUrl, 'http://127.0.0.1:8000');
    });

    test(
      'login sends the FastAPI request contract to the configured URL',
      () async {
        late http.Request sentRequest;
        final api = ApiService(
          tokenStorage: FakeTokenStorage(),
          baseUrl: 'http://10.0.2.2:8000',
          client: MockClient((request) async {
            sentRequest = request;
            return _json({'access_token': _fakeToken, 'token_type': 'bearer'});
          }),
        );

        await api.login(email: 'asha@example.com', password: 'secret123');

        expect(sentRequest.method, 'POST');
        expect(sentRequest.url, Uri.parse('http://10.0.2.2:8000/login'));
        expect(sentRequest.headers['Content-Type'], 'application/json');
        expect(jsonDecode(sentRequest.body), {
          'email': 'asha@example.com',
          'password': 'secret123',
        });
      },
    );

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

    test(
      'Lost and Found methods use the FastAPI report and claim contract',
      () async {
        final requests = <http.Request>[];
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            requests.add(request);
            if (request.url.path == '/lost-found/my-reports') {
              return _json({'items': [], 'total': 0});
            }
            if (request.url.path == '/lost-found/') {
              return _json({'id': 'report-1'}, 201);
            }
            if (request.url.path == '/lost-found/report-1/matches') {
              return _json({'items': [], 'high_confidence': []});
            }
            if (request.url.path == '/lost-found/matches/match-1/request') {
              return _json({
                'id': 'claim-1',
                'verification_status': 'pending',
              }, 201);
            }
            if (request.url.path == '/lost-found/claims/incoming') {
              return _json({'items': []});
            }
            if (request.url.path == '/lost-found/images/test.png') {
              return http.Response.bytes([137, 80, 78, 71], 200);
            }
            if (request.url.path.endsWith('/review')) {
              return _json({'verification_status': 'approved'});
            }
            if (request.url.path == '/lost-found/report-1/close') {
              return _json({'status': 'closed'});
            }
            return _json({'detail': 'Not Found'}, 404);
          }),
        );

        expect(await api.getLostFoundReports(), isEmpty);
        await api.createLostFoundReport({
          'report_type': 'lost',
          'item_name': 'Blue backpack',
          'image': {
            'name': 'item.png',
            'type': 'image/png',
            'size': 8,
            'data': 'iVBORw0KGgo=',
          },
        });
        await api.getLostFoundMatches('report-1');
        await api.requestLostFoundMatch('match-1');
        expect(await api.getIncomingLostFoundClaims(), isEmpty);
        await api.reviewLostFoundClaim(
          matchId: 'match-1',
          claimId: 'claim-1',
          decision: 'approved',
        );
        await api.updateLostFoundStatus(reportId: 'report-1', status: 'close');
        expect(await api.getLostFoundImage('/api/lost-found/images/test.png'), [
          137,
          80,
          78,
          71,
        ]);

        expect(
          requests.map((request) => '${request.method} ${request.url.path}'),
          [
            'GET /lost-found/my-reports',
            'POST /lost-found/',
            'GET /lost-found/report-1/matches',
            'POST /lost-found/matches/match-1/request',
            'GET /lost-found/claims/incoming',
            'PATCH /lost-found/matches/match-1/claims/claim-1/review',
            'PATCH /lost-found/report-1/close',
            'GET /lost-found/images/test.png',
          ],
        );
        expect(
          requests.every(
            (request) =>
                request.headers['Authorization'] == 'Bearer $_fakeToken',
          ),
          isTrue,
        );
        final createBody = jsonDecode(requests[1].body) as Map<String, dynamic>;
        expect((createBody['image'] as Map)['type'], 'image/png');
      },
    );
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

    testWidgets('student dashboard displays the redesigned overview', (
      tester,
    ) async {
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

      expect(find.text('MAKE TODAY A STEP FORWARD'), findsOneWidget);
      expect(find.text('Attendance'), findsWidgets);
      expect(find.text('CGPA'), findsOneWidget);
      expect(find.text('Assignments'), findsOneWidget);
      expect(find.text('Study streak'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Mood and wellbeing'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Mood and wellbeing'), findsOneWidget);
    });

    testWidgets('student dashboard fits a narrow phone viewport', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

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

      expect(find.text('CGPA'), findsOneWidget);
      expect(find.text('Study streak'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('AI Campus Assistant'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('AI Campus Assistant'), findsOneWidget);
      expect(tester.takeException(), isNull);
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

    test(
      'API parses history and returns a newly submitted complaint',
      () async {
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
      },
    );

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
      expect(
        find.textContaining('The repair has been completed.'),
        findsOneWidget,
      );
      expect(
        find.text('Resolution notes: The lamp was replaced.'),
        findsOneWidget,
      );
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
      String userRole = 'student',
    }) {
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(students: students, userRole: userRole),
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

    testWidgets('faculty can open the student directory', (tester) async {
      final storage = FakeTokenStorage();
      await tester.pumpWidget(buildApp(storage, userRole: 'faculty'));
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
      expect(find.text('Lost & Found'), findsNothing);

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

    testWidgets('students can open Lost and Found, not the directory', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildApp(FakeTokenStorage(_fakeToken), students: []),
      );
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      expect(find.text('Students'), findsNothing);
      expect(find.text('Lost & Found'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(NavigationBar),
          matching: find.text('Lost & Found'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Lost and Found'), findsOneWidget);
      expect(
        find.byKey(const Key('lost_found_report_type_filter')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('lost_found_search')), findsOneWidget);
    });

    testWidgets('admin login opens admin tools only', (tester) async {
      await tester.pumpWidget(buildApp(FakeTokenStorage(), userRole: 'admin'));
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

      expect(find.text('Admin Console'), findsOneWidget);
      expect(find.text('Faculty Portal'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Mood and wellbeing'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Aggregate wellbeing analytics'), findsOneWidget);
    });

    testWidgets('faculty login opens faculty tools only', (tester) async {
      await tester.pumpWidget(
        buildApp(FakeTokenStorage(), userRole: 'faculty'),
      );
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

      expect(find.text('Faculty Portal'), findsOneWidget);
      expect(find.text('Mark Attendance'), findsOneWidget);
      expect(find.text('Lost & Found'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Mood and wellbeing'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Aggregate wellbeing analytics'), findsOneWidget);
      expect(find.text('Admin Console'), findsNothing);
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
      expect(sentBody?['mode'], 'general');
      expect(sentBody?['history'], history);
      expect(response['intent'], 'faculty_details');
    });

    test('assistant API forwards the selected mode', () async {
      Map<String, dynamic>? sentBody;
      final api = ApiService(
        tokenStorage: FakeTokenStorage(_fakeToken),
        client: MockClient((request) async {
          sentBody = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'reply': 'Study reply'});
        }),
      );

      await api.askAssistant('Help me revise', mode: 'study');

      expect(sentBody?['mode'], 'study');
    });

    test(
      'assistant API preserves mode, placement, mood and study contracts',
      () async {
        final requests = <http.Request>[];
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            requests.add(request);
            if (request.url.path == '/assistant/conversations') {
              return request.method == 'GET'
                  ? _json(<Map<String, dynamic>>[])
                  : _json({'id': 'conversation-1', 'mode': 'study'});
            }
            if (request.url.path == '/assistant/chat') {
              return _json({
                'reply': 'Grounded response',
                'mode': 'placement',
                'conversation_id': 'conversation-1',
                'suggestions': ['Next question'],
                'sources': ['placement profile'],
              });
            }
            if (request.url.path == '/assistant/mood/check-ins') {
              return _json({'id': 'mood-1', 'mood': 'good'});
            }
            if (request.url.path ==
                '/assistant/study/documents/document-1/flashcards') {
              return _json({
                'flashcards': [
                  {'front': 'What is a tree?', 'back': 'A data structure.'},
                ],
              });
            }
            return _json({'detail': 'Not found'}, 404);
          }),
        );

        expect(
          await api.listAssistantConversations(mode: 'placement'),
          isEmpty,
        );
        expect(
          (await api.createAssistantConversation(mode: 'study'))['mode'],
          'study',
        );
        final chat = await api.askAssistant(
          'Plan my preparation',
          mode: 'placement',
          conversationId: 'conversation-1',
          placementContext: {
            'company': 'Example Corp',
            'role': 'Analyst',
            'salary': 'Confidential',
            'current_skills': ['Python'],
            'skills_to_improve': ['SQL'],
            'preparation_level': 'beginner',
            'application_timeline': '3 months',
          },
        );
        expect(chat['reply'], 'Grounded response');
        expect(chat['suggestions'], ['Next question']);
        expect(
          (await api.createMoodCheckIn(
            'good',
            reflection: 'I feel prepared.',
          ))['mood'],
          'good',
        );
        expect(
          (await api.createStudyFlashcards('document-1'))['flashcards'],
          hasLength(1),
        );

        expect(requests[0].url.queryParameters, {'mode': 'placement'});
        expect(requests[1].url.queryParameters, {'mode': 'study'});
        final chatBody = jsonDecode(requests[2].body) as Map<String, dynamic>;
        expect(chatBody['conversation_id'], 'conversation-1');
        expect(chatBody['placement_context'], {
          'company': 'Example Corp',
          'role': 'Analyst',
          'salary': 'Confidential',
          'current_skills': ['Python'],
          'skills_to_improve': ['SQL'],
          'preparation_level': 'beginner',
          'application_timeline': '3 months',
        });
        expect(jsonDecode(requests[3].body), {
          'mood': 'good',
          'reflection': 'I feel prepared.',
        });
        expect(
          requests.map((request) => request.headers['Authorization']),
          everyElement('Bearer $_fakeToken'),
        );
      },
    );

    test(
      'placement research sends optional job details and external consent',
      () async {
        final sentBodies = <Map<String, dynamic>>[];
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            sentBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
            return _json({
              'available': false,
              'summary': null,
              'sources': <Map<String, dynamic>>[],
              'reason': 'Search is unavailable.',
            });
          }),
        );

        await api.researchPlacement(
          careerGoal: 'Data analyst',
          jobDescription: 'SQL and Python experience',
        );
        await api.researchPlacement(
          careerGoal: 'Data analyst',
          jobDescription: ' SQL and Python experience ',
          allowExternalProcessing: true,
        );

        expect(sentBodies, [
          {
            'career_goal': 'Data analyst',
            'job_description': 'SQL and Python experience',
            'allow_external_processing': false,
          },
          {
            'career_goal': 'Data analyst',
            'job_description': 'SQL and Python experience',
            'allow_external_processing': true,
          },
        ]);
      },
    );

    test(
      'private assistant APIs use the agreed authenticated endpoints',
      () async {
        final requests = <http.BaseRequest>[];
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            requests.add(request);
            switch (request.url.path) {
              case '/assistant/mood/check-ins':
                if (request.method == 'POST') {
                  return _json({'id': 'check-in-1', 'mood': 'good'});
                }
                return _json({'check_ins': <Map<String, dynamic>>[]});
              case '/assistant/mood/analytics':
                return _json({
                  'suppressed': false,
                  'minimum_group_size': 5,
                  'groups': <Map<String, dynamic>>[],
                });
              case '/assistant/study/documents':
                return _json({'documents': <Map<String, dynamic>>[]});
              case '/assistant/study/documents/document-1':
                return _json({'deleted': true, 'id': 'document-1'});
              case '/assistant/study/documents/document-1/quiz':
                return _json({
                  'questions': [
                    {'question': 'Question?', 'answer': 'Answer'},
                  ],
                });
              case '/assistant/placement/research':
                return _json({
                  'available': false,
                  'summary': null,
                  'sources': <Map<String, dynamic>>[],
                  'reason': 'Search is unavailable.',
                });
              case '/assistant/placement/documents/document-1/analysis':
                return _json({
                  'technical_skills': ['Python'],
                });
              case '/assistant/placement/documents/document-1':
                return _json({'deleted': true, 'id': 'document-1'});
              case '/assistant/placement/documents':
                return _json({'documents': <Map<String, dynamic>>[]});
              case '/assistant/placement/job-description/analysis':
                return _json({
                  'explicit_requirements': ['Python required'],
                });
            }
            return _json({'detail': 'Not found'}, 404);
          }),
        );

        expect((await api.createMoodCheckIn('good'))['mood'], 'good');
        expect(await api.getMyMoodCheckIns(), isEmpty);
        expect((await api.getMoodAnalytics())['minimum_group_size'], 5);
        expect(await api.getStudyDocuments(), isEmpty);
        expect(await api.getPlacementDocuments(), isEmpty);
        await api.deleteStudyDocument('document-1');
        expect(
          (await api.createStudyQuiz('document-1'))['questions'],
          hasLength(1),
        );
        final research = await api.researchPlacement(
          careerGoal: 'Data analyst',
        );
        expect(
          (await api.analyzePlacementDocument(
            'document-1',
          ))['technical_skills'],
          ['Python'],
        );
        await api.deletePlacementDocument('document-1');
        expect(
          (await api.analyzePlacementJobDescription(
            'Python required',
          ))['explicit_requirements'],
          ['Python required'],
        );

        expect(research['available'], isFalse);
        expect(jsonDecode((requests.first as http.Request).body), {
          'mood': 'good',
        });
        expect(requests.map((request) => request.url.path), [
          '/assistant/mood/check-ins',
          '/assistant/mood/check-ins',
          '/assistant/mood/analytics',
          '/assistant/study/documents',
          '/assistant/placement/documents',
          '/assistant/study/documents/document-1',
          '/assistant/study/documents/document-1/quiz',
          '/assistant/placement/research',
          '/assistant/placement/documents/document-1/analysis',
          '/assistant/placement/documents/document-1',
          '/assistant/placement/job-description/analysis',
        ]);
        expect(
          requests.every(
            (request) =>
                request.headers['Authorization'] == 'Bearer $_fakeToken',
          ),
          isTrue,
        );
      },
    );

    test(
      'assistant document upload sends a multipart file with auth',
      () async {
        final requests = <http.BaseRequest>[];
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            requests.add(request);
            return _json({
              'id': 'document-1',
              'filename': 'study_material.txt',
            });
          }),
        );
        final fixture = File('test\\fixtures\\study_material.txt')
            .absolute
            .path;

        await api.uploadStudyDocument(fixture);
        await api.uploadPlacementDocument(fixture);
        await api.uploadStudyDocumentBytes(
          Uint8List.fromList('Study Buddy upload test fixture'.codeUnits),
          'study_material.txt',
        );

        expect(requests, hasLength(3));
        for (final request in requests) {
          expect(request, isA<http.Request>());
          expect(request.headers['Authorization'], 'Bearer $_fakeToken');
          expect(
            request.headers['Content-Type'],
            startsWith('multipart/form-data; boundary='),
          );
          final body = (request as http.Request).body;
          expect(body, contains('name="file"; filename="study_material.txt"'));
          expect(body, contains('Study Buddy upload test fixture'));
        }
        expect(requests.map((request) => request.url.path), [
          '/assistant/study/documents',
          '/assistant/placement/documents',
          '/assistant/study/documents',
        ]);
      },
    );

    test(
      'assistant upload API rejects unsupported extensions before sending',
      () async {
        var requestsSent = 0;
        final api = ApiService(
          tokenStorage: FakeTokenStorage(_fakeToken),
          client: MockClient((request) async {
            requestsSent++;
            return _json({'id': 'unexpected'});
          }),
        );

        await expectLater(
          api.uploadStudyDocument('untrusted.exe'),
          throwsA(
            isA<ApiException>().having(
              (error) => error.message,
              'message',
              'Choose a PDF, DOCX, or TXT file.',
            ),
          ),
        );
        expect(requestsSent, 0);
      },
    );

    Future<Widget> wrap(
      Widget screen, {
      String userRole = 'student',
      List<Map<String, dynamic>>? conversationsSeed,
      List<Map<String, dynamic>>? studyDocumentsSeed,
      List<int>? conversationListStatuses,
      void Function(http.Request request)? onAssistantChat,
      Map<String, dynamic> Function(http.Request request)? onPlacementResearch,
    }) async {
      final storage = FakeTokenStorage(_fakeToken);
      final api = ApiService(
        tokenStorage: storage,
        client: _fakeBackend(
          userRole: userRole,
          conversationsSeed: conversationsSeed,
          studyDocumentsSeed: studyDocumentsSeed,
          conversationListStatuses: conversationListStatuses,
          onAssistantChat: onAssistantChat,
          onPlacementResearch: onPlacementResearch,
        ),
      );
      final auth = AuthController(api: api, tokenStorage: storage);
      await auth.restoreSession();
      return AppScope(
        api: api,
        auth: auth,
        child: MaterialApp(home: screen),
      );
    }

    testWidgets(
      'AI Assistant screen displays greeting, suggested questions and answers',
      (tester) async {
        await tester.pumpWidget(await wrap(const CampusAssistantScreen()));
        await tester.pumpAndSettle();

        expect(find.text('AI Campus Assistant'), findsOneWidget);
        expect(find.text('General Campus Assistant'), findsOneWidget);
        expect(find.text('Placement Assistant'), findsOneWidget);
        expect(find.text('Study Buddy'), findsOneWidget);
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

    testWidgets('assistant controls fit narrow screens and keyboard insets', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(await wrap(const CampusAssistantScreen()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('assistant_mode_selector')), findsOneWidget);
      expect(find.byTooltip('Saved Conversations'), findsOneWidget);
      expect(find.byTooltip('More assistant options'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.byKey(const Key('assistant_mode_selector')));
      await tester.pumpAndSettle();
      expect(find.text('General Campus Assistant'), findsWidgets);
      expect(find.text('Placement Assistant'), findsOneWidget);
      expect(find.text('Study Buddy'), findsOneWidget);
      expect(find.text('Mood Detector'), findsOneWidget);
      await tester.tap(find.text('Study Buddy'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Add PDF, DOCX or TXT'));
      expect(
        find.textContaining('Supported: PDF, DOCX, TXT; maximum 5 MB.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);

      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Send'), findsOneWidget);
      expect(
        tester.getRect(find.byTooltip('Send')).bottom,
        lessThanOrEqualTo(520),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('assistant responses copy and failed requests can be retried', (
      tester,
    ) async {
      final copiedTexts = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copiedTexts.add(
              (call.arguments as Map<Object?, Object?>)['text'] as String,
            );
          }
          return null;
        },
      );
      var chatRequests = 0;
      await tester.pumpWidget(
        await wrap(
          const CampusAssistantScreen(),
          onAssistantChat: (_) {
            chatRequests++;
            if (chatRequests == 1) {
              throw http.ClientException('Test network interruption');
            }
          },
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Copy response').first);
      await tester.pumpAndSettle();
      expect(copiedTexts, hasLength(1));
      expect(copiedTexts.single, contains('AI Campus Assistant'));
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextField).first,
        'What is my attendance percentage?',
      );
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      await tester.pumpAndSettle();
      expect(find.text('Try again'), findsOneWidget);

      await tester.tap(find.text('Try again'));
      await tester.pump();
      await tester.pumpAndSettle();
      expect(chatRequests, 2);
      expect(find.textContaining('77.6%'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);

      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      );
    });

    testWidgets('assistant history errors are visible and can be retried', (
      tester,
    ) async {
      await tester.pumpWidget(
        await wrap(
          const CampusAssistantScreen(),
          conversationListStatuses: [503, 200],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Conversation history unavailable'), findsOneWidget);
      expect(find.text('Conversation service unavailable'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.text('Conversation history unavailable'), findsNothing);
    });

    testWidgets(
      'assistant mode changes isolate conversations and legacy chats default to general',
      (tester) async {
        final chatBodies = <Map<String, dynamic>>[];
        final screen = const CampusAssistantScreen();
        await tester.pumpWidget(
          await wrap(
            screen,
            conversationsSeed: [
              {
                'id': 'legacy-general',
                'title': 'Legacy general',
                'messages': [
                  {'role': 'assistant', 'content': 'Legacy general reply'},
                ],
              },
              {
                'id': 'placement-chat',
                'mode': 'placement',
                'title': 'Placement history',
                'messages': [
                  {'role': 'assistant', 'content': 'Placement only reply'},
                ],
              },
              {
                'id': 'study-chat',
                'mode': 'study',
                'title': 'Study history',
                'messages': [
                  {'role': 'assistant', 'content': 'Study only reply'},
                ],
              },
            ],
            onAssistantChat: (request) {
              chatBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
            },
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byTooltip('Saved Conversations'));
        await tester.pumpAndSettle();
        expect(find.text('Legacy general'), findsOneWidget);
        expect(find.text('Placement history'), findsNothing);
        expect(find.text('Study history'), findsNothing);
        await tester.tap(find.text('Legacy general'));
        await tester.pumpAndSettle();
        expect(find.text('Legacy general reply'), findsOneWidget);

        await tester.tap(find.text('Placement Assistant'));
        await tester.pumpAndSettle();
        expect(find.text('Legacy general reply'), findsNothing);
        await tester.tap(find.byTooltip('Saved Conversations'));
        await tester.pumpAndSettle();
        expect(find.text('Legacy general'), findsNothing);
        expect(find.text('Placement history'), findsOneWidget);
        expect(find.text('Study history'), findsNothing);
        await tester.tap(find.text('Placement history'));
        await tester.pumpAndSettle();
        expect(find.text('Placement only reply'), findsOneWidget);

        await tester.tap(find.text('Study Buddy'));
        await tester.pumpAndSettle();
        expect(find.text('Placement only reply'), findsNothing);
        await tester.tap(find.byTooltip('Saved Conversations'));
        await tester.pumpAndSettle();
        expect(find.text('Legacy general'), findsNothing);
        expect(find.text('Placement history'), findsNothing);
        expect(find.text('Study history'), findsOneWidget);
        await tester.tap(find.text('Study history'));
        await tester.pumpAndSettle();
        expect(find.text('Study only reply'), findsOneWidget);

        await tester.enterText(
          find.byType(TextField).first,
          'Review this topic',
        );
        await tester.tap(find.byTooltip('Send'));
        await tester.pump();
        await tester.pumpAndSettle();
        expect(chatBodies, hasLength(1));
        expect(chatBodies.single['mode'], 'study');
        expect(chatBodies.single['conversation_id'], 'study-chat');
        expect(
          (chatBodies.single['history'] as List).any(
            (turn) => turn['content'] == 'Placement only reply',
          ),
          isFalse,
        );
      },
    );

    testWidgets('AI Assistant asks for free time and displays free window', (
      tester,
    ) async {
      await tester.pumpWidget(await wrap(const CampusAssistantScreen()));
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
      'assistant mode selection is student-only and mood is separate',
      (tester) async {
        await tester.pumpWidget(
          await wrap(
            const CampusAssistantScreen(),
            studyDocumentsSeed: [
              {
                'id': 'study-document-1',
                'filename': 'study_material.txt',
                'summary': 'A private study document summary.',
                'word_count': 9,
              },
            ],
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Study Buddy'));
        await tester.pumpAndSettle();
        expect(find.text('Add PDF, DOCX or TXT'), findsOneWidget);
        await tester.ensureVisible(find.text('Add PDF, DOCX or TXT'));
        await tester.ensureVisible(find.text('study_material.txt').first);
        expect(find.text('A private study document summary.'), findsOneWidget);
        await tester.tap(find.text('Practice quiz'));
        await tester.pumpAndSettle();
        expect(find.text('Complete the statement: ____'), findsOneWidget);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Flashcards'));
        await tester.tap(find.text('Flashcards'));
        await tester.pumpAndSettle();
        expect(find.text('What is a tree?'), findsOneWidget);
        await tester.tap(find.byKey(const Key('study_flashcard')));
        await tester.pumpAndSettle();
        expect(find.text('A data structure.'), findsOneWidget);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byTooltip('Delete study_material.txt'));
        await tester.tap(find.byTooltip('Delete study_material.txt'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Delete'));
        await tester.pumpAndSettle();
        expect(find.text('No study documents yet.'), findsOneWidget);

        await tester.tap(find.byTooltip('More assistant options'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Mood and wellbeing (private)'));
        await tester.pumpAndSettle();
        expect(find.text('Mood and wellbeing'), findsOneWidget);
        expect(find.textContaining('non-diagnostic'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.textContaining('No mood check-ins yet.'),
          300,
          scrollable: find.byType(Scrollable).last,
        );
        expect(find.textContaining('No mood check-ins yet.'), findsOneWidget);
        await tester.tap(find.byType(DropdownButtonFormField<String>));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Low').last);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('mood_private_reflection')),
          'I will take a short break and ask a friend for support.',
        );
        await tester.tap(find.text('Save private check-in'));
        await tester.pumpAndSettle();
        expect(find.text('Low'), findsNWidgets(2));
        expect(
          find.textContaining('I will take a short break'),
          findsOneWidget,
        );
        expect(
          find.textContaining('This check-in is not a diagnosis.'),
          findsOneWidget,
        );

        await tester.pageBack();
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Placement Assistant'));
        await tester.tap(find.text('Placement Assistant'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Upload job description or CV'));
        expect(find.text('Upload job description or CV'), findsOneWidget);

        await tester.pumpWidget(
          await wrap(const CampusAssistantScreen(), userRole: 'faculty'),
        );
        await tester.pumpAndSettle();
        expect(find.text('Placement Assistant'), findsNothing);
        expect(find.text('Study Buddy'), findsNothing);
        await tester.tap(find.byTooltip('More assistant options'));
        await tester.pumpAndSettle();
        expect(find.text('Placement Practice'), findsNothing);
        await tester.tap(find.text('Mood and wellbeing (private)'));
        await tester.pumpAndSettle();
        expect(find.text('Aggregate wellbeing analytics'), findsOneWidget);
        expect(
          find.text('No aggregate analytics are available yet.'),
          findsOneWidget,
        );
        expect(find.text('Your private check-in history'), findsNothing);
      },
    );

    testWidgets('assistant upload rejects unsupported and oversized files', (
      tester,
    ) async {
      final fixture = File('test\\fixtures\\study_material.txt').absolute;
      Future<Widget> screenFor(AssistantPickedDocument selected, String key) =>
          wrap(
            CampusAssistantScreen(
              key: Key(key),
              filePicker: () async => selected,
            ),
          );

      await tester.pumpWidget(
        await screenFor(
          AssistantPickedDocument(
            name: 'unsupported.exe',
            size: fixture.lengthSync(),
            path: fixture.path,
          ),
          'unsupported',
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Study Buddy'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Add PDF, DOCX or TXT'));
      await tester.tap(find.text('Add PDF, DOCX or TXT'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a PDF, DOCX, or TXT file.'), findsOneWidget);

      await tester.pumpWidget(
        await screenFor(
          AssistantPickedDocument(
            name: 'too-large.pdf',
            size: 5 * 1024 * 1024 + 1,
            path: fixture.path,
          ),
          'too-large',
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Study Buddy'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Add PDF, DOCX or TXT'));
      await tester.tap(find.text('Add PDF, DOCX or TXT'));
      await tester.pumpAndSettle();
      expect(find.text('Documents must be 5 MB or smaller.'), findsOneWidget);
    });

    testWidgets('assistant document upload supports browser file bytes', (
      tester,
    ) async {
      final bytes = Uint8List.fromList('Browser study material'.codeUnits);
      await tester.pumpWidget(
        await wrap(
          CampusAssistantScreen(
            filePicker: () async => AssistantPickedDocument(
              name: 'study_material.txt',
              size: bytes.length,
              path: null,
              bytes: bytes,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Study Buddy'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Add PDF, DOCX or TXT'));
      await tester.tap(find.text('Add PDF, DOCX or TXT'));
      await tester.pumpAndSettle();

      expect(find.text('study_material.txt'), findsWidgets);
      expect(
        find.text(
          'This platform did not provide readable file data for upload.',
        ),
        findsNothing,
      );
    });

    testWidgets(
      'placement research requires consent and only displays web citations',
      (tester) async {
        final sentBodies = <Map<String, dynamic>>[];
        var researchCount = 0;
        await tester.pumpWidget(
          await wrap(
            const CampusAssistantScreen(),
            onPlacementResearch: (request) {
              sentBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
              researchCount++;
              if (researchCount == 1) {
                return {
                  'available': false,
                  'summary': null,
                  'sources': <Map<String, dynamic>>[],
                  'reason': 'The configured search provider is unavailable.',
                };
              }
              return {
                'available': true,
                'summary': 'Returned placement research summary.',
                'sources': [
                  {
                    'title': 'Campus career guide',
                    'url': 'https://careers.example.edu/roles',
                  },
                  {
                    'title': 'HTTP career guide',
                    'url': 'http://careers.example.edu/entry-level',
                  },
                  {'title': 'Unsafe citation', 'url': 'javascript:alert(1)'},
                  {'title': 'Relative citation', 'url': '/careers'},
                  {
                    'title': 'Credential URL',
                    'url': 'https://user@careers.example.edu/roles',
                  },
                ],
              };
            },
          ),
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Placement Assistant'));
        await tester.tap(find.text('Placement Assistant'));
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('placement_career_goal')),
        );
        await tester.enterText(
          find.byKey(const Key('placement_career_goal')),
          'Data analyst',
        );
        await tester.ensureVisible(
          find.byKey(const Key('placement_job_description')),
        );
        await tester.enterText(
          find.byKey(const Key('placement_job_description')),
          'SQL and Python experience',
        );
        final consentFinder = find.byKey(
          const Key('placement_external_processing_consent'),
        );
        await tester.ensureVisible(consentFinder);
        expect(tester.widget<CheckboxListTile>(consentFinder).value, isFalse);
        await tester.ensureVisible(find.text('Check placement research'));
        await tester.tap(find.text('Check placement research'));
        await tester.pumpAndSettle();
        expect(find.text('Placement research unavailable'), findsOneWidget);
        expect(
          find.text('The configured search provider is unavailable.'),
          findsOneWidget,
        );

        await tester.ensureVisible(consentFinder);
        await tester.tap(consentFinder);
        await tester.pumpAndSettle();
        expect(tester.widget<CheckboxListTile>(consentFinder).value, isTrue);
        await tester.ensureVisible(find.text('Check placement research'));
        await tester.tap(find.text('Check placement research'));
        await tester.pumpAndSettle();
        expect(
          find.text('Returned placement research summary.'),
          findsOneWidget,
        );
        await tester.ensureVisible(find.text('Campus career guide'));
        expect(find.text('Campus career guide'), findsOneWidget);
        expect(find.text('https://careers.example.edu/roles'), findsOneWidget);
        expect(
          find.text('http://careers.example.edu/entry-level'),
          findsOneWidget,
        );
        expect(find.text('Unsafe citation'), findsNothing);
        expect(find.text('Relative citation'), findsNothing);
        expect(find.text('Credential URL'), findsNothing);

        expect(sentBodies, [
          {
            'career_goal': 'Data analyst',
            'job_description': 'SQL and Python experience',
            'allow_external_processing': false,
          },
          {
            'career_goal': 'Data analyst',
            'job_description': 'SQL and Python experience',
            'allow_external_processing': true,
          },
        ]);

        await tester.ensureVisible(find.text('General Campus Assistant'));
        await tester.tap(find.text('General Campus Assistant'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Placement Assistant'));
        await tester.tap(find.text('Placement Assistant'));
        await tester.pumpAndSettle();
        expect(tester.widget<CheckboxListTile>(consentFinder).value, isFalse);
      },
    );

    testWidgets(
      'Notifications screen displays weekly low attendance warnings',
      (tester) async {
        await tester.pumpWidget(await wrap(const NotificationsScreen()));
        await tester.pumpAndSettle();

        expect(find.text('Notifications'), findsOneWidget);
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
