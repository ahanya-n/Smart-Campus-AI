import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/student.dart';
import '../services/api_service.dart';
import '../widgets/state_views.dart';

/// Portal for faculty members to mark and submit class session attendance.
class FacultyDashboardScreen extends StatefulWidget {
  const FacultyDashboardScreen({super.key});

  @override
  State<FacultyDashboardScreen> createState() => _FacultyDashboardScreenState();
}

class _FacultyDashboardScreenState extends State<FacultyDashboardScreen> {
  List<Student> _students = [];
  bool _loadingStudents = true;
  String? _studentsError;

  String? _selectedSubject;
  String _subjectName = '';
  DateTime _sessionDate = DateTime.now();
  TimeOfDay _startTime = const TimeOfDay(hour: 9, minute: 0);

  final Map<String, String> _statuses = {};
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _loadStudents();
  }

  Future<void> _loadStudents() async {
    setState(() {
      _loadingStudents = true;
      _studentsError = null;
    });

    final api = AppScope.read(context).api;
    try {
      final list = await api.getStudents();
      if (mounted) {
        setState(() {
          _students = list;
          for (final s in list) {
            _statuses[s.studentId] = 'present';
          }
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _studentsError = e.message);
    } finally {
      if (mounted) setState(() => _loadingStudents = false);
    }
  }

  void _markAll(String status) {
    setState(() {
      for (final s in _students) {
        _statuses[s.studentId] = status;
      }
    });
  }

  String _formatTimeOfDay(TimeOfDay time) {
    final hour = time.hour.toString().padLeft(2, '0');
    final minute = time.minute.toString().padLeft(2, '0');
    return '$hour:$minute';
  }

  String _formatDate(DateTime date) {
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }

  Future<void> _submitAttendance() async {
    final subject = _selectedSubject?.trim().toUpperCase();
    if (subject == null || subject.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select or enter a subject code.')),
      );
      return;
    }

    if (_students.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No students in roster to mark attendance.')),
      );
      return;
    }

    setState(() => _submitting = true);

    final api = AppScope.read(context).api;
    final records = _students.map((s) {
      return {
        'student_id': s.studentId,
        'status': _statuses[s.studentId] ?? 'present',
      };
    }).toList();

    try {
      final result = await api.recordSessionAttendance(
        subjectCode: subject,
        subjectName: _subjectName.isEmpty ? subject : _subjectName,
        sessionDate: _formatDate(_sessionDate),
        startTime: _formatTimeOfDay(_startTime),
        records: records,
      );

      if (mounted) {
        final created = result['created'] ?? 0;
        final updated = result['updated'] ?? 0;
        final unchanged = result['unchanged'] ?? 0;
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.check_circle_outline_rounded,
                color: Colors.green, size: 40),
            title: const Text('Attendance Recorded'),
            content: Text(
              'Successfully recorded attendance for $subject on ${_formatDate(_sessionDate)}.\n\n'
              '• New marks: $created\n'
              '• Updated marks: $updated\n'
              '• Unchanged: $unchanged',
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    final user = auth.user;
    final assigned = user?.assignedSubjectCodes ?? [];

    if (_selectedSubject == null && assigned.isNotEmpty) {
      _selectedSubject = assigned.first;
    }

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Faculty Portal'),
        actions: [
          IconButton(
            tooltip: 'Reload students',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _loadingStudents ? null : _loadStudents,
          ),
        ],
      ),
      body: _loadingStudents
          ? const LoadingView(message: 'Loading student roster...')
          : _studentsError != null
              ? MessageView(
                  icon: Icons.error_outline_rounded,
                  title: 'Failed to load roster',
                  message: _studentsError!,
                  actionLabel: 'Try again',
                  onAction: _loadStudents,
                  isError: true,
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                  children: [
                    // Header card
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: scheme.primaryContainer,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(Icons.badge_outlined,
                                  color: scheme.onPrimaryContainer),
                              const SizedBox(width: 8),
                              Text(
                                user?.name ?? 'Faculty',
                                style: theme.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                  color: scheme.onPrimaryContainer,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Text(
                            assigned.isEmpty
                                ? 'No subjects assigned yet. Ask admin to assign subjects.'
                                : 'Assigned Subjects: ${assigned.join(', ')}',
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: scheme.onPrimaryContainer,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Session Setup Card
                    Card(
                      elevation: 0,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                        side: BorderSide(color: scheme.outlineVariant),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Class Session Details',
                              style: theme.textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(height: 12),
                            if (assigned.isNotEmpty)
                              DropdownButtonFormField<String>(
                                initialValue: _selectedSubject,
                                decoration: const InputDecoration(
                                  labelText: 'Subject',
                                  prefixIcon: Icon(Icons.menu_book_rounded),
                                ),
                                items: assigned
                                    .map((code) => DropdownMenuItem(
                                          value: code,
                                          child: Text(code),
                                        ))
                                    .toList(),
                                onChanged: (val) =>
                                    setState(() => _selectedSubject = val),
                              )
                            else
                              TextFormField(
                                initialValue: _selectedSubject,
                                decoration: const InputDecoration(
                                  labelText: 'Subject Code (e.g. MCA401)',
                                  prefixIcon: Icon(Icons.menu_book_rounded),
                                ),
                                onChanged: (val) => _selectedSubject = val,
                              ),
                            const SizedBox(height: 12),
                            TextFormField(
                              decoration: const InputDecoration(
                                labelText: 'Subject Name (optional)',
                                prefixIcon: Icon(Icons.title_rounded),
                              ),
                              onChanged: (val) => _subjectName = val,
                            ),
                            const SizedBox(height: 12),
                            Row(
                              children: [
                                Expanded(
                                  child: OutlinedButton.icon(
                                    icon: const Icon(Icons.calendar_today_rounded,
                                        size: 18),
                                    label: Text(_formatDate(_sessionDate)),
                                    onPressed: () async {
                                      final picked = await showDatePicker(
                                        context: context,
                                        initialDate: _sessionDate,
                                        firstDate: DateTime.now().subtract(
                                            const Duration(days: 365)),
                                        lastDate: DateTime.now(),
                                      );
                                      if (picked != null) {
                                        setState(() => _sessionDate = picked);
                                      }
                                    },
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: OutlinedButton.icon(
                                    icon: const Icon(Icons.access_time_rounded,
                                        size: 18),
                                    label: Text(_formatTimeOfDay(_startTime)),
                                    onPressed: () async {
                                      final picked = await showTimePicker(
                                        context: context,
                                        initialTime: _startTime,
                                      );
                                      if (picked != null) {
                                        setState(() => _startTime = picked);
                                      }
                                    },
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Quick Actions Row
                    Row(
                      children: [
                        Text(
                          'Student Roster (${_students.length})',
                          style: theme.textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const Spacer(),
                        TextButton(
                          onPressed: () => _markAll('present'),
                          child: const Text('All Present'),
                        ),
                        TextButton(
                          onPressed: () => _markAll('absent'),
                          child: const Text('All Absent'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),

                    // Student list
                    for (final student in _students) ...[
                      Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        elevation: 0,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                          side: BorderSide(color: scheme.outlineVariant),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 14, vertical: 8),
                          child: Row(
                            children: [
                              CircleAvatar(
                                radius: 18,
                                child: Text(
                                  student.name.isNotEmpty
                                      ? student.name[0].toUpperCase()
                                      : 'S',
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      student.name,
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w600),
                                    ),
                                    Text(
                                      '${student.studentId} • ${student.department} Sem ${student.semester}',
                                      style: theme.textTheme.bodySmall?.copyWith(
                                          color: scheme.onSurfaceVariant),
                                    ),
                                  ],
                                ),
                              ),
                              SegmentedButton<String>(
                                segments: const [
                                  ButtonSegment(
                                    value: 'present',
                                    label: Text('P'),
                                  ),
                                  ButtonSegment(
                                    value: 'absent',
                                    label: Text('A'),
                                  ),
                                ],
                                selected: {
                                  _statuses[student.studentId] ?? 'present'
                                },
                                onSelectionChanged: (val) {
                                  setState(() {
                                    _statuses[student.studentId] = val.first;
                                  });
                                },
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],

                    const SizedBox(height: 24),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      icon: _submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.check_rounded),
                      label: Text(_submitting
                          ? 'Submitting...'
                          : 'Submit Attendance Session'),
                      onPressed: _submitting ? null : _submitAttendance,
                    ),
                  ],
                ),
    );
  }
}
