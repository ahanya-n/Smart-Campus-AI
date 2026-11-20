import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        appBar: AppBar(
          title: const Text(
            "Profile Card",
            style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
          ),
          centerTitle: true,
        ),
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              const scrollPadding = 24.0;
              return SingleChildScrollView(
                padding: const EdgeInsets.all(scrollPadding),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: (constraints.maxHeight - scrollPadding * 2)
                        .clamp(0.0, double.infinity)
                        .toDouble(),
                  ),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 350),
                      child: Card(
                        elevation: 28,
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Image.asset(
                                'assets/images/profile.png',
                                width: 120,
                                height: 120,
                                errorBuilder: (context, error, stackTrace) =>
                                    const Icon(Icons.person, size: 120),
                              ),
                              const SizedBox(height: 20),
                              const Text(
                                "Dinesh N",
                                style: TextStyle(
                                  fontSize: 26,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 10),
                              const Text(
                                "Assistant Professor",
                                style: TextStyle(fontSize: 20),
                              ),
                              const SizedBox(height: 10),
                              const Text(
                                "School of Information Science",
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 16),
                              ),
                              const SizedBox(height: 5),
                              const Text(
                                "Presidency University, Bengaluru",
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 16),
                              ),
                              const SizedBox(height: 20),
                              Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: const Column(
                                  children: [
                                    Text(
                                      "Email: dinesh@example.com",
                                      style: TextStyle(fontSize: 15),
                                    ),
                                    SizedBox(height: 8),
                                    Text(
                                      "Mobile: 9876543210",
                                      style: TextStyle(fontSize: 15),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
