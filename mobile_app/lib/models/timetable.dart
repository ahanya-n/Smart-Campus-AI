import 'student_summary.dart';

const List<String> weekDays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/// Today's name if it is a class day (Mon-Sat), otherwise Monday.
String defaultTimetableDay(DateTime now) =>
    now.weekday <= weekDays.length ? weekDays[now.weekday - 1] : weekDays.first;

/// One class slot, from GET /timetable.
class TimetableEntry {
  const TimetableEntry({
    this.id = '',
    required this.dayOfWeek,
    required this.subjectCode,
    required this.subjectName,
    required this.startTime,
    required this.endTime,
    required this.facultyName,
    required this.roomNumber,
    required this.isDemo,
  });

  final String id;
  final String dayOfWeek;
  final String subjectCode;
  final String subjectName;
  final String startTime;
  final String endTime;
  final String facultyName;
  final String roomNumber;
  final bool isDemo;

  factory TimetableEntry.fromJson(Map<String, dynamic> json) {
    String read(String key) => (json[key] ?? '').toString();
    return TimetableEntry(
      id: read('id'),
      dayOfWeek: read('day_of_week'),
      subjectCode: read('subject_code'),
      subjectName: read('subject_name'),
      startTime: read('start_time'),
      endTime: read('end_time'),
      facultyName: read('faculty_name'),
      roomNumber: read('room_number'),
      isDemo: json['is_demo'] == true,
    );
  }

  /// True if [now] falls inside this class (times are "HH:MM").
  bool isOngoing(DateTime now) {
    final current =
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    return current.compareTo(startTime) >= 0 && current.compareTo(endTime) < 0;
  }
}

/// Full response of GET /timetable.
class TimetableData {
  const TimetableData({
    required this.linked,
    required this.isDemo,
    required this.message,
    required this.student,
    required this.entries,
  });

  final bool linked;
  final bool isDemo;
  final String? message;
  final StudentSummary? student;
  final List<TimetableEntry> entries;

  List<TimetableEntry> entriesFor(String day) =>
      entries.where((e) => e.dayOfWeek == day).toList()
        ..sort((a, b) => a.startTime.compareTo(b.startTime));

  factory TimetableData.fromJson(Map<String, dynamic> json) {
    final entries = json['entries'];
    return TimetableData(
      linked: json['linked'] == true,
      isDemo: json['is_demo'] == true,
      message: json['message']?.toString(),
      student: StudentSummary.fromJson(json['student']),
      entries: entries is List
          ? entries
              .whereType<Map<String, dynamic>>()
              .map(TimetableEntry.fromJson)
              .toList()
          : const [],
    );
  }
}
