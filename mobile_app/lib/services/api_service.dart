import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../config/api_config.dart';
import '../models/app_user.dart';
import '../models/attendance.dart';
import '../models/complaint.dart';
import '../models/library.dart';
import '../models/student.dart';
import '../models/timetable.dart';
import '../models/transport.dart';
import 'token_storage.dart';

/// An error from the backend or the network, with a message safe to show users.
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  final String message;

  /// HTTP status code, or null when the server could not be reached.
  final int? statusCode;

  bool get isUnauthorized => statusCode == 401;
  bool get isNetworkError => statusCode == null;

  @override
  String toString() => message;
}

enum _Auth { none, required }

/// Talks to the Smart Campus FastAPI backend.
class ApiService {
  ApiService({
    required this._tokenStorage,
    http.Client? client,
    this.baseUrl = ApiConfig.baseUrl,
    this.timeout = ApiConfig.timeout,
  }) : _client = client ?? http.Client();

  final TokenStorage _tokenStorage;
  final http.Client _client;
  final String baseUrl;
  final Duration timeout;

  /// POST /register
  Future<void> register({
    required String name,
    required String email,
    required String password,
  }) async {
    await _request(
      'POST',
      '/register',
      body: {'name': name, 'email': email, 'password': password},
    );
  }

  /// POST /login — returns the JWT access token.
  Future<String> login({
    required String email,
    required String password,
  }) async {
    final data = await _request(
      'POST',
      '/login',
      body: {'email': email, 'password': password},
    );

    final token = data is Map ? data['access_token'] : null;
    if (token is! String || token.isEmpty) {
      throw const ApiException('The server did not return an access token.');
    }
    return token;
  }

  /// GET /me — requires a stored token.
  Future<AppUser> getCurrentUser() async {
    final data = await _request('GET', '/me', auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected response from the server.');
    }
    return AppUser.fromJson(data);
  }

  /// POST /me/link-student — redeems an admin-issued one-time student code.
  Future<AppUser> linkMyStudent({
    required String studentId,
    required String linkCode,
  }) async {
    final data = await _request(
      'POST',
      '/me/link-student',
      body: {'student_id': studentId, 'link_code': linkCode},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected response from the server.');
    }
    final user = AppUser.fromJson(data);
    if (!user.isStudent || user.studentId != studentId.trim()) {
      throw const ApiException('The server did not confirm the student link.');
    }
    return user;
  }

  /// GET /students — requires authentication; students receive only their own record.
  Future<List<Student>> getStudents() async {
    final data = await _request('GET', '/students', auth: _Auth.required);
    if (data is! List) {
      throw const ApiException('Unexpected response from the server.');
    }
    return data
        .whereType<Map<String, dynamic>>()
        .map(Student.fromJson)
        .toList();
  }

  /// GET /library/books — catalog search is performed by the backend.
  Future<List<LibraryBook>> getLibraryBooks({String search = ''}) async {
    final query = search.trim();
    final path = query.isEmpty
        ? '/library/books'
        : '/library/books?search=${Uri.encodeQueryComponent(query)}';
    final data = await _request('GET', path, auth: _Auth.required);
    if (data is! List) {
      throw const ApiException(
        'Unexpected library catalog response from server.',
      );
    }
    return data
        .whereType<Map<String, dynamic>>()
        .map(LibraryBook.fromJson)
        .toList();
  }

  /// GET /library/loans — returns the signed-in user's borrowing history.
  Future<List<BookLoan>> getLibraryLoans() async {
    final data = await _request('GET', '/library/loans', auth: _Auth.required);
    if (data is! List) {
      throw const ApiException(
        'Unexpected library history response from server.',
      );
    }
    return data
        .whereType<Map<String, dynamic>>()
        .map(BookLoan.fromJson)
        .toList();
  }

  /// POST /library/books/{bookId}/borrow.
  Future<BookLoan> borrowLibraryBook(String bookId) async {
    final data = await _request(
      'POST',
      '/library/books/${Uri.encodeComponent(bookId)}/borrow',
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected library loan response from server.');
    }
    return BookLoan.fromJson(data);
  }

  /// POST /library/loans/{loanId}/return.
  Future<void> returnLibraryBook(String loanId) async {
    await _request(
      'POST',
      '/library/loans/${Uri.encodeComponent(loanId)}/return',
      auth: _Auth.required,
    );
  }

  /// GET /complaints — the signed-in student's own complaint history.
  Future<List<CampusComplaint>> getComplaints() async {
    final data = await _request('GET', '/complaints', auth: _Auth.required);
    if (data is! Map<String, dynamic> || data['items'] is! List) {
      throw const ApiException('Unexpected complaints response from server.');
    }
    return (data['items'] as List)
        .whereType<Map<String, dynamic>>()
        .map(CampusComplaint.fromJson)
        .toList();
  }

  /// POST /complaints — students can submit their own complaint.
  Future<CampusComplaint> createComplaint({
    required String category,
    required String title,
    required String description,
  }) async {
    final data = await _request(
      'POST',
      '/complaints',
      body: {'category': category, 'title': title, 'description': description},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected complaint response from server.');
    }
    return CampusComplaint.fromJson(data);
  }

  /// POST /library/books — administrators only.
  Future<LibraryBook> createLibraryBook({
    required String title,
    required String author,
    required String isbn,
    required String category,
    required int totalCopies,
  }) async {
    final data = await _request(
      'POST',
      '/library/books',
      body: {
        'title': title,
        'author': author,
        'isbn': isbn,
        'category': category,
        'total_copies': totalCopies,
      },
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected library catalog response from server.',
      );
    }
    return LibraryBook.fromJson(data);
  }

  /// PATCH /library/books/{bookId} — administrators only.
  Future<LibraryBook> updateLibraryBookInventory({
    required String bookId,
    required int totalCopies,
  }) async {
    final data = await _request(
      'PATCH',
      '/library/books/${Uri.encodeComponent(bookId)}',
      body: {'total_copies': totalCopies},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected library catalog response from server.',
      );
    }
    return LibraryBook.fromJson(data);
  }

  /// GET /transport/routes — driver contact and student roster are admin-only.
  Future<List<TransportRoute>> getTransportRoutes() async {
    final data = await _request(
      'GET',
      '/transport/routes',
      auth: _Auth.required,
    );
    if (data is! List) {
      throw const ApiException(
        'Unexpected transport routes response from server.',
      );
    }
    return data
        .whereType<Map<String, dynamic>>()
        .map(TransportRoute.fromJson)
        .toList();
  }

  /// GET /transport/me — the signed-in student's own recorded assignment.
  Future<StudentTransportDetails> getMyTransport() async {
    final data = await _request('GET', '/transport/me', auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected student transport response from server.',
      );
    }
    return StudentTransportDetails.fromJson(data);
  }

  /// POST /transport/routes — administrators only.
  Future<TransportRoute> createTransportRoute(TransportRouteDraft route) async {
    final data = await _request(
      'POST',
      '/transport/routes',
      body: route.toJson(),
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected transport route response from server.',
      );
    }
    return TransportRoute.fromJson(data);
  }

  /// PATCH /transport/routes/{id} — administrators only.
  Future<TransportRoute> updateTransportRoute({
    required String routeId,
    required TransportRouteDraft route,
  }) async {
    final data = await _request(
      'PATCH',
      '/transport/routes/${Uri.encodeComponent(routeId)}',
      body: route.toJson(),
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected transport route response from server.',
      );
    }
    return TransportRoute.fromJson(data);
  }

  /// DELETE /transport/routes/{id} — only routes without assignments.
  Future<void> deleteTransportRoute(String routeId) async {
    await _request(
      'DELETE',
      '/transport/routes/${Uri.encodeComponent(routeId)}',
      auth: _Auth.required,
    );
  }

  /// POST /transport/routes/{id}/assignments — administrators only.
  Future<void> assignStudentToTransport({
    required String routeId,
    required String studentId,
    required String pickupPoint,
    required String dropPoint,
  }) async {
    await _request(
      'POST',
      '/transport/routes/${Uri.encodeComponent(routeId)}/assignments',
      body: {
        'student_id': studentId,
        'pickup_point': pickupPoint,
        'drop_point': dropPoint,
      },
      auth: _Auth.required,
    );
  }

  /// DELETE /transport/routes/{id}/assignments/{studentId}.
  Future<void> removeStudentFromTransport({
    required String routeId,
    required String studentId,
  }) async {
    await _request(
      'DELETE',
      '/transport/routes/${Uri.encodeComponent(routeId)}/assignments/'
          '${Uri.encodeComponent(studentId)}',
      auth: _Auth.required,
    );
  }

  /// GET /attendance/me — set [demo] to view the labelled demo records.
  Future<AttendanceReport> getAttendance({bool demo = false}) async {
    final data = await _request(
      'GET',
      demo ? '/attendance/me?demo=true' : '/attendance/me',
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected response from the server.');
    }
    return AttendanceReport.fromJson(data);
  }

  /// GET /timetable (whole week) — set [demo] to view the demo timetable.
  Future<TimetableData> getTimetable({bool demo = false}) async {
    final data = await _request(
      'GET',
      demo ? '/timetable?demo=true' : '/timetable',
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected response from the server.');
    }
    return TimetableData.fromJson(data);
  }

  /// GET /admin/stats
  Future<Map<String, dynamic>> getAdminStats() async {
    final data = await _request('GET', '/admin/stats', auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected stats response from the server.');
    }
    return data;
  }

  /// GET /admin/users
  Future<List<Map<String, dynamic>>> getAdminUsers() async {
    final data = await _request('GET', '/admin/users', auth: _Auth.required);
    if (data is! List) {
      throw const ApiException('Unexpected users response from the server.');
    }
    return data.whereType<Map<String, dynamic>>().toList();
  }

  /// POST /admin/users
  Future<Map<String, dynamic>> createUser({
    required String name,
    required String email,
    required String password,
    required String role,
  }) async {
    final data = await _request(
      'POST',
      '/admin/users',
      body: {'name': name, 'email': email, 'password': password, 'role': role},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected response from the server.');
    }
    return data;
  }

  /// PATCH /admin/users/{userId}/role
  Future<void> updateRole(String userId, String role) async {
    await _request(
      'PATCH',
      '/admin/users/$userId/role',
      body: {'role': role},
      auth: _Auth.required,
    );
  }

  /// PUT /admin/users/{userId}/subjects
  Future<void> assignSubjects(String userId, List<String> subjects) async {
    await _request(
      'PUT',
      '/admin/users/$userId/subjects',
      body: {'subject_codes': subjects},
      auth: _Auth.required,
    );
  }

  /// PUT /admin/users/{userId}/student-link
  Future<void> linkStudent(String userId, String? studentId) async {
    await _request(
      'PUT',
      '/admin/users/$userId/student-link',
      body: {'student_id': studentId},
      auth: _Auth.required,
    );
  }

  /// POST /admin/students/{studentId}/link-code
  Future<String> generateLinkCode(String studentId) async {
    final data = await _request(
      'POST',
      '/admin/students/$studentId/link-code',
      auth: _Auth.required,
    );
    if (data is Map && data['link_code'] != null) {
      return data['link_code'].toString();
    }
    throw const ApiException('Failed to generate link code.');
  }

  /// POST /timetable
  Future<void> createTimetableEntry(Map<String, dynamic> entry) async {
    await _request('POST', '/timetable', body: entry, auth: _Auth.required);
  }

  /// DELETE /timetable/{id}
  Future<void> deleteTimetableEntry(String id) async {
    await _request('DELETE', '/timetable/$id', auth: _Auth.required);
  }

  /// POST /attendance/sessions
  Future<Map<String, dynamic>> recordSessionAttendance({
    required String subjectCode,
    required String subjectName,
    required String sessionDate,
    required String startTime,
    required List<Map<String, String>> records,
  }) async {
    final data = await _request(
      'POST',
      '/attendance/sessions',
      body: {
        'subject_code': subjectCode,
        'subject_name': subjectName,
        'session_date': sessionDate,
        'start_time': startTime,
        'records': records,
      },
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected session response from server.');
    }
    return data;
  }

  /// POST /assistant/chat
  Future<Map<String, dynamic>> askAssistant(
    String message, {
    String? day,
    List<Map<String, dynamic>> history = const [],
  }) async {
    final body = <String, dynamic>{'message': message};
    if (day != null) body['day'] = day;
    if (history.isNotEmpty) body['history'] = history;
    final data = await _request(
      'POST',
      '/assistant/chat',
      body: body,
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected assistant response from server.');
    }
    return data;
  }

  /// GET /academic-intelligence/me — authenticated student's own report.
  Future<Map<String, dynamic>> getMyAcademicReport() async {
    final data = await _request(
      'GET',
      '/academic-intelligence/me',
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected academic report response from server.',
      );
    }
    return data;
  }

  /// POST /academic-intelligence/mentor — uses only the linked student's data.
  Future<Map<String, dynamic>> askAcademicMentor(String message) async {
    final data = await _request(
      'POST',
      '/academic-intelligence/mentor',
      body: {'message': message},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected academic mentor response from server.',
      );
    }
    return data;
  }

  /// GET /academic-intelligence/overview — server-scoped admin/faculty view.
  Future<Map<String, dynamic>> getAcademicOverview({
    String? department,
    int? semester,
    String? section,
    String? search,
  }) async {
    final parameters = <String, String>{
      if (department != null && department.trim().isNotEmpty)
        'department': department.trim(),
      if (semester != null) 'semester': '$semester',
      if (section != null && section.trim().isNotEmpty)
        'section': section.trim(),
      if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
    };
    final path = parameters.isEmpty
        ? '/academic-intelligence/overview'
        : '/academic-intelligence/overview?${Uri(queryParameters: parameters).query}';
    final data = await _request('GET', path, auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected academic overview response from server.',
      );
    }
    return data;
  }

  /// GET /academic-intelligence/students/{id}; access is checked by the server.
  Future<Map<String, dynamic>> getAcademicStudentReport(
    String studentId,
  ) async {
    final data = await _request(
      'GET',
      '/academic-intelligence/students/${Uri.encodeComponent(studentId)}',
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected student academic report from server.',
      );
    }
    return data;
  }

  /// POST /academic-intelligence/interventions — faculty/admin only.
  Future<Map<String, dynamic>> createAcademicIntervention({
    required String studentId,
    required String note,
    String followUpStatus = 'pending',
  }) async {
    final data = await _request(
      'POST',
      '/academic-intelligence/interventions',
      body: {
        'student_id': studentId,
        'note': note,
        'follow_up_status': followUpStatus,
      },
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected mentoring action response from server.',
      );
    }
    return data;
  }

  /// PATCH /academic-intelligence/interventions/{id}; access is class-scoped.
  Future<Map<String, dynamic>> updateAcademicIntervention({
    required String interventionId,
    required String followUpStatus,
  }) async {
    final data = await _request(
      'PATCH',
      '/academic-intelligence/interventions/${Uri.encodeComponent(interventionId)}',
      body: {'follow_up_status': followUpStatus},
      auth: _Auth.required,
    );
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected mentoring action response from server.',
      );
    }
    return data;
  }

  /// GET /assistant/free-time
  Future<Map<String, dynamic>> getFreeTime({String? day}) async {
    final path = day != null
        ? '/assistant/free-time?day=$day'
        : '/assistant/free-time';
    final data = await _request('GET', path, auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException('Unexpected free-time response from server.');
    }
    return data;
  }

  /// GET /notifications
  Future<Map<String, dynamic>> getNotifications() async {
    final data = await _request('GET', '/notifications', auth: _Auth.required);
    if (data is! Map<String, dynamic>) {
      throw const ApiException(
        'Unexpected notifications response from server.',
      );
    }
    return data;
  }

  /// PATCH /notifications/{id}/read
  Future<void> markNotificationRead(String id) async {
    await _request('PATCH', '/notifications/$id/read', auth: _Auth.required);
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    _Auth auth = _Auth.none,
  }) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (body != null) headers['Content-Type'] = 'application/json';

    if (auth != _Auth.none) {
      final token = await _tokenStorage.readToken();
      if (token != null && token.isNotEmpty) {
        headers['Authorization'] = 'Bearer $token';
      } else if (auth == _Auth.required) {
        throw const ApiException('You are not signed in.', statusCode: 401);
      }
    }

    final uri = Uri.parse('$baseUrl$path');
    final request = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);

    if (kDebugMode) debugPrint('[api] -> $method $uri');

    final http.Response response;
    try {
      final streamed = await _client.send(request).timeout(timeout);
      response = await http.Response.fromStream(streamed).timeout(timeout);
    } on TimeoutException catch (error) {
      if (kDebugMode) {
        debugPrint('[api] timeout $method $uri (${error.runtimeType})');
      }
      throw const ApiException(
        'The server took too long to respond. Please try again.',
      );
    } on SocketException catch (error) {
      if (kDebugMode) {
        debugPrint('[api] connection error $method $uri: ${error.message}');
      }
      throw ApiException(_unreachableMessage);
    } on http.ClientException catch (error) {
      if (kDebugMode) {
        debugPrint('[api] client error $method $uri: ${error.message}');
      }
      throw ApiException(_unreachableMessage);
    }

    if (kDebugMode) {
      debugPrint('[api] <- $method $uri HTTP ${response.statusCode}');
    }

    dynamic decoded;
    if (response.bodyBytes.isNotEmpty) {
      try {
        decoded = jsonDecode(utf8.decode(response.bodyBytes));
      } on FormatException {
        decoded = null;
      }
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return decoded;
    }

    throw ApiException(
      _errorMessage(response.statusCode, decoded),
      statusCode: response.statusCode,
    );
  }

  String get _unreachableMessage =>
      "Can't reach the server at $baseUrl. "
      'Make sure the backend is running, then try again.';

  /// Turns FastAPI's {"detail": ...} error bodies into readable text.
  static String _errorMessage(int status, dynamic decoded) {
    final detail = decoded is Map ? decoded['detail'] : null;

    if (detail is String && detail.trim().isNotEmpty) return detail;

    if (detail is List && detail.isNotEmpty) {
      final messages = detail.map((item) {
        if (item is Map && item['msg'] != null) {
          final loc = item['loc'];
          final field = loc is List && loc.isNotEmpty ? loc.last : null;
          return field != null && field != 'body'
              ? '$field: ${item['msg']}'
              : '${item['msg']}';
        }
        return item.toString();
      });
      return messages.join('\n');
    }

    if (status == 401) return 'Your session has expired. Please sign in again.';
    if (status == 404) return 'The requested resource was not found.';
    if (status >= 500) {
      return 'The server ran into a problem (HTTP $status). Please try again later.';
    }
    return 'Request failed (HTTP $status).';
  }
}
